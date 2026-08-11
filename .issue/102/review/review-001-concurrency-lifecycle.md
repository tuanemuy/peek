# Concurrency & Lifecycle Review #001

**Date:** 2026-07-25
**Round:** 1回目
**対象:** PR #116 (`issue/102/fix-shutdown-hang` @ `3693d5d`) / base `46cc093`

---

## Summary

- Blockers: 0
- Warnings: 6
- Notes: 8
- Verdict: **APPROVED**

主要な並行制御・ライフサイクル上の主張はすべて**実測で裏を取り、成立を確認した**。新たなレース・ハング・リソースリークは検出できなかった。指摘はいずれも「今日は踏まないが、この PR が掲げた『たまたま同期だから安全、に依存しない』という基準に照らすと不整合」というレベルであり、マージを止めるものではない。

---

## 検証方法（この結論の根拠）

スクラッチパッドに `origin/issue/102/fix-shutdown-hang` の worktree を作り、実際にコードを走らせて確認した（検証ファイルはリポジトリに残していない）。Node v22.22.1 / macOS。

| # | 検証内容 | 結果 |
|---|---|---|
| V-1 | `pnpm test` 相当（`vitest run`） | 27 files / 266 tests pass |
| V-2 | `withTimeout` タイムアウト後に元 promise が reject → unhandled rejection になるか | **ならない**（`then(onF,onR)` が既に付いており、派生 promise も fulfilled になる）。ゼロ予算経路も `catch(()=>{})` で保護 |
| V-3 | `node:timers/promises` の `delay` のリスナーリーク | 正常完了 6 回後 `getEventListeners(signal,"abort").length` = `[0,0,0,0,0,0]`。**リークなし**（AC-8 成立） |
| V-4 | 既に abort 済み signal を `delay` に渡す | 即 reject（`AbortError` / `code: ABORT_ERR`）。リスナー残数 0 |
| V-5 | 待機中 abort | 22ms で reject、リスナー残数 0 |
| V-6 | `delay` の既定 `ref` | `ref: true`（800ms の delay 単独でイベントループが生存）。旧手書き `setTimeout` と同等で回帰なし |
| V-7 | `process.on("SIGINT", handler)` の引数 | `"SIGINT"`（string）が渡る。シグネチャ変更は正しい |
| V-8 | AC-4: `shutdown()` から戻った直後の TCP 接続 | `ECONNREFUSED`（リスナーは最初の `await` 前に閉じている） |
| V-9 | 実 CLI に実 SIGINT（SSE 接続あり） | exit 0 / 4ms |
| V-10 | **`server.close()` が永久に解決しないよう注入**して実 CLI に SIGINT | **exit 0 / 2009ms**、`[peek] HTTP server did not close within 2000ms …` を出力。**AC-1 / AC-2 が間接検証でなく実測で成立** |
| V-11 | 同上 + 200ms 後に 2 回目 SIGINT | **exit 1 / 207ms**、`Force exiting...`。force exit 経路は壊れていない |
| V-12 | `server.close()` が reject するよう注入 | CLI が catch → `logger.error` → exit 0。透過 reject は握られている |
| V-13 | SSE の登録同期性 | `sse.app.request("/sse")` の**直後**に `clientCount === 1`。同一同期ブロック内で `shutdown()` すると 0 になり body も EOF |
| V-14 | ①/② の間にマイクロタスクを 0〜3 個挟んで shutdown | すべて `status=200 / clientCount=0`（取りこぼしなし） |
| V-15 | 25 本の未 drain SSE + 5 本の idle keep-alive + 再接続ストーム下の `shutdown()` | 1ms で resolve、unhandled rejection なし、シャットダウン後の接続は `ECONNREFUSED` |
| V-16 | Hono `StreamingApi.write()` の挙動 | ソースを読み、実測もした。**例外は必ず握りつぶして resolve する**（`.catch(cleanup)` は死にコードだった → 削除は正しい）。ただし**バックプレッシャー下では永久 pending になりうる**（下記 N-005） |
| V-17 | 破損 stdout パイプ + SIGINT の exit code | PR: 1 / base: **1**（回帰ではない。原因は `console.log()` の非同期 EPIPE） |

---

## 受け入れ基準の判定（担当観点分）

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1 | ✅ | V-9 / V-10 / V-11。`server.close()` が永久保留でも 2009ms・exit 0 |
| AC-2 | ✅ | V-10 が「間接検証」の穴を実測で埋めた。`shutdown()` の唯一の待機点が `withTimeout` であることもコードで確認 |
| AC-3 | ✅ | `index.test.ts` の 2 テストが pass。実タイマー経路も V-10 で warn が 1 回出ることを確認 |
| AC-4 | ✅ | V-8 |
| AC-5 | ✅ | `sse.test.ts` が 503 と `content-type` を検証。ただし N-004 参照 |
| AC-6 | ✅ | 同上 + V-13 / V-14 |
| AC-8 | ✅ | V-3（実測 0 リスナー） |

---

### Concurrency & Lifecycle

#### Blockers

なし。

#### Warnings

- **[W-001]** `shutdown()` の手順順序が、コメントが掲げる根拠と一致していない。`close()` は手順 1 であるべき
  - 場所: `src/server/index.ts:225-236`
  - 理由: 手順 2 のコメントは「**再接続を誘発しうるものより先に**リスナーを止める」と書いているが、実際には手順 1 の `sse.shutdown()` が先に走る。`sse.shutdown()` は接続中の SSE ストリームを全部終端させる操作であり、**まさにブラウザの `onerror` → 自前 `setTimeout(connect, delay)` を誘発する**（`src/client/lib/sse.ts` / `src/server/renderer/html-document.tsx`）。つまりコメントの不変条件は、手順 1〜4 の間に `await` が無いという「たまたま」によってのみ守られている。この PR 自身が ADR-001 で「現行の安全性が『たまたま await が無い』ことに依存しているのが問題」と述べているのだから、その基準は `shutdown()` 本体にも適用されるべき。
  - あわせて **エラー分離が無い**点も同じ場所の問題である。手順 1 か手順 3 が throw すると、以降の `close()` / `closeAllConnections()` / `withTimeout` がすべてスキップされる。特に手順 3（`watcher.close()`）が throw した場合、`closing` は生成済みなのに `withTimeout` が呼ばれず、**`closing` に reject ハンドラが一切付かない状態**になる（`server.close()` が `ERR_SERVER_NOT_RUNNING` 等で reject すれば unhandled rejection）。今日の `watcher.close()`（`src/lib/watcher.ts:70-80`、`FSWatcher.close()` と `clearTimeout` のみ）は throw しないので到達しないが、AC-4 の保証が「手順 1・3 が絶対に throw しない」ことに依存しているのは構造として弱い。
  - 提案: `close()` を手順 1 に移す。そうすれば (a) コメントの根拠と実装が一致し、(b) AC-4（リスナー閉鎖）が他の手順の成否から独立し、(c) `closing` は必ず `withTimeout` に渡る。`sse.shutdown()` は `shuttingDown` フラグで新規 `/sse` を拒むだけなので、リスナー閉鎖より後でも取りこぼしはない（V-13/V-14 で確認済み）。

- **[W-002]** `shutdownPromise` の代入は IIFE の最初の `await` **より後**に完了するため、手順 1〜4 の実行中は `shutdownPromise === undefined` のままで、再入ガードが効いていない
  - 場所: `src/server/index.ts:222-246`
  - 理由: `shutdownPromise = (async () => { …手順1〜4… await … })();` は、右辺の IIFE 本体が最初の `await` に到達するまで同期実行され、**その後に**代入が起きる。したがって手順 1〜4 の途中で同期的に `shutdown()` が再入されると、ガード `if (shutdownPromise) return shutdownPromise;` を素通りして 2 度目の完全なシャットダウンが走る（`sse.shutdown()` は冪等、`watcher.close()` も冪等、`close()` は memo 済みなので実害は今日は無い、が `closeAllConnections()` の二重実行と 2 本目の `shutdownPromise` が生まれる）。現状は手順 1〜4 のどれもコールバックを介して外部コードを呼ばないので到達しない（`cleanup()` → `abortController.abort()` の同期リスナーは `delay` 内部のものだけ、`socket.destroy()` の 'close' は nextTick、`FSWatcher.close()` の 'close' も nextTick）。
  - 提案: ガードとして先にフラグ／プレースホルダを立てるか、`const run = async () => {…}; shutdownPromise = run();` ではなく `shutdownPromise = Promise.resolve().then(run)` のように**代入を同期完了させてから**本体を走らせる…のは AC-4（最初の await 前にリスナーが閉じている）を壊すので不可。素直には `let started = false;` を追加して先に立てるのがよい。少なくともコメントで「手順 1〜4 は同期的に外部へ制御を渡さないこと」を不変条件として明記すべき。

- **[W-003]** SSE ハンドラの二重チェックは `shuttingDown` しかカバーしておらず、**per-client abort の取りこぼし**に対しては無防備。`stream.onAbort()` の登録が `clients.add()` より後にある
  - 場所: `src/server/routes/sse.ts:73-84`
  - 理由: Hono の `StreamingApi.abort()` は `if (!this.aborted) { this.aborted = true; abortSubscribers.forEach(...) }`（`node_modules/hono/dist/utils/stream.js`）であり、**`abort()` 後に `onAbort()` で登録したリスナーは二度と呼ばれない**。つまり `clients.add(client)`（73行）と `stream.onAbort(cleanup)`（74行）の間に将来 `await` が 1 つ入り、その窓で接続が切れると、`cleanup()` が永久に呼ばれず client が `clients` に残り続ける（keep-alive ループも 30 秒ごとに回り続ける）。② の再チェック（81行）は `shuttingDown` しか見ないのでこのケースを救わない。現行コードでは `run(stream, cb)` が `c.newResponse()` **より前**に呼ばれるため、レスポンスがまだ存在せず `@hono/node-server` の `writable.on("close", cancel)`（`dist/index.mjs:294`）も付いていない → `abort()` は起きえない（V-13 で `clientCount` が同期的に 1 になることも確認）。したがって今日は到達しないが、W-001 と同じ「たまたま」依存である。
  - 提案: `stream.onAbort(cleanup)` を `clients.add(client)` より**前**に移す（`cleanup` は `client` を参照するが、関数宣言と `const client` の TDZ の関係上そのままでは動かないので `client` の宣言も前倒しする）。あわせて ② を `if (shuttingDown || stream.aborted) { cleanup(); return; }` にすると、二重チェックの主張が「shuttingDown に限らない」ものになる。

- **[W-004]** ② の再チェック分岐（`src/server/routes/sse.ts:81-84`）は**現行の Hono では到達不能**であり、その旨がコード上に書かれていない
  - 場所: `src/server/routes/sse.ts:76-84`
  - 理由: ① の判定・`clients.add`・② の判定はすべて同一同期ブロック内にある（`app.get` ハンドラ → `streamSSE` → `run()`（await なし呼び出し）→ `cb` の最初の `await` まで同期）。V-13 でも `app.request("/sse")` 直後に `clientCount === 1` になることを実測した。`sse.shutdown()` も完全に同期なので、この 2 ブロックは interleave しない。つまり ② に落ちる経路は存在せず、**テストでも直接カバーできていない**（`sse.test.ts` の「503」テストは ① を通る）。防御的コードとしての価値は認めるが、「到達不能だが将来 `clients.add` の前に await が入ったときの保険」であることを書かないと、読者は「実際に起きるレース」と誤解する。
  - 提案: コメントに「現行 Hono では到達不能。`clients.add` より前に await が入った場合の保険」と明記する。あわせて 79-80 行の「the response was already handed back」は**事実誤り**（`run()` は `c.newResponse()` より前に呼ばれるので、この時点でレスポンスはまだ返されていない）。結果（200 + `text/event-stream` + 即 EOF）自体は正しいので、理由づけだけ直せばよい。

- **[W-005]** 手順 4 のコメントの根拠が Node 19+ の実装と食い違っている
  - 場所: `src/server/index.ts:232-233`
  - 理由: 「Without this, keep-alive sockets stay open and `server.close()` waits forever」とあるが、Node 19 以降の `http.Server.prototype.close` は先頭で `httpServerPreClose(server)` を呼び、その中で **`server.closeIdleConnections()` を実行している**（本レビューで `node -p "require('http').Server.prototype.close.toString()"` および `--expose-internals` で `httpServerPreClose` の本体を確認）。`package.json` の `engines` は `>=22.0.0` なので常にこの経路。したがって idle keep-alive ソケットは `close()` 自身が始末しており、`closeAllConnections()` が本当に必要なのは **active（＝レスポンス送信中の SSE）ソケット**に対してだけ。理由が間違っていると、将来「close() が closeIdleConnections を呼ぶなら手順 4 は不要では」と誤って削除される危険がある（実際には SSE が残って 2 秒のタイムアウトに毎回落ちるようになる）。
  - 提案: コメントを「idle は `server.close()` 内部の `closeIdleConnections()` が始末する。ここで必要なのは**送信中の SSE ストリームを抱えた active ソケット**を落とすこと」に直す。

- **[W-006]** テスト `stops accepting connections before shutdown() is awaited` が `shutting` を await の跨ぎでフローティングにしている
  - 場所: `src/server/index.test.ts:105-107`
  - 理由: `const shutting = server.shutdown();` の直後に `await expect(fetch(...)).rejects.toThrow();` を挟んでから `await shutting;` している。この窓の間 `shutting` には reject ハンドラが付いていないため、`server.close()` が reject した場合（現実には起きにくいが、`withTimeout` は reject を透過する設計）にテストランナー側の unhandled rejection になる。**シャットダウンの reject 経路の unhandled rejection を潰したい PR で、テストが同じパターンを持ち込んでいる**のは一貫性を欠く。
  - 提案: `const shutting = server.shutdown(); shutting.catch(() => {});` を足すか、`const settled = shutting.then(() => "ok", (e) => e);` の形にして必ずハンドラを先に付ける。

#### Notes

- **[N-001]** `withTimeout` の unhandled rejection 対策は**正しく機能している**（V-2）。タイムアウト側で `resolve()` した後に `promise` が reject しても、(a) `then(onF, onR)` の `onR` が既に接続済みなので元 promise は handled、(b) `onR` は `reject(error)` を呼ぶだけで自身は正常 return するため派生 promise も fulfilled、という二段で漏れがない。ゼロ予算の早期 return 経路にも `promise.catch(() => {})` が張られている。`Promise.race` を使わず手書きにした判断も、ゼロ予算を決定的にするために必要で妥当。

- **[N-002]** `node:timers/promises` への置換は**実測で正しい**。正常完了 6 回で abort リスナー残数 0（旧手書き `sleep()` は 1 回ごとに +1）、abort 済み signal は即 `AbortError` で reject しリスナーも残さない、待機中 abort は即座に reject。`catch { break; }` が `AbortError` を吸って抜ける形も正しい。`ref` を指定していない（既定 `ref: true`）点も、旧実装のグローバル `setTimeout` と等価なので回帰にならない。SSE 接続中にプロセスが自然終了しなくなる懸念は**元から同じ**であり、そもそも接続中はソケット自体が ref されている。

- **[N-003]** `stream.write(...)` の `.catch(cleanup)` 削除は正しい。`StreamingApi.write()` は `try { await this.writer.write(input) } catch {}` で必ず握りつぶして resolve する（ソース確認 + 実測）。一方 `writeSSE()` は `write()` に到達する**前**に `event`/`id`/`retry` の `\r\n` 検証で `throw` しうるので、`send` 側（`sse.ts:67`）に `.catch(cleanup)` を残した判断も正しい。**両者を区別できている**。

- **[N-004]** AC-5 の 503 分岐は、**実運用ではほぼ到達しない**。V-15 で再接続ストームを回しながら `shutdown()` したところ、観測された 503 は 0 件、`ECONNREFUSED` が 1 件だった。手順 2 でリスナーが閉じるため、シャットダウン後の `/sse` は TCP レベルで弾かれる。到達しうるのは「既に accept 済みの keep-alive ソケット上で次のリクエストが来る」場合だけだが、それも手順 4 の `closeAllConnections()` で潰れる。多層防御としては妥当だが、AC-5/AC-6 が `sse.app.request()` レベルでしか検証できていない（＝実サーバー経由では検証不能）ことは認識しておくとよい。

- **[N-005]** `await stream.write(": keep-alive\n\n")` は**バックプレッシャー下で無期限 pending になりうる**（実測: `responseReadable` を誰も読まない状態で 2 回目の write が 800ms 経っても未解決）。この場合 `cleanup()`（＝`abortController.abort()`）は pending な `write()` を解けないので、`sse.shutdown()` 単体ではその client のストリームは EOF に達しない。ただし本番では必ず解ける: (a) `closeAllConnections()` でソケットが破棄されると `@hono/node-server` の `writable.on("close", cancel)` → `reader.cancel()` → `responseReadable.cancel` → `stream.abort()` が走り、pending な `write()` は 1ms で解決する（実測）、(b) 誰かが body を読み始めれば即座に解ける（実測）。`clients` からは `cleanup()` で既に外れているのでリークにもならない。**したがってハング要因にはならない**が、「per-client abort が唯一の終端手段」という AC-7 の説明にはこの穴がある。

- **[N-006]** `isHttpServer(server)` が false になる経路は現状存在しない。`@hono/node-server` の `createAdaptorServer` は `options.createServer || http.createServer` で、`startServer` は `createServer` を渡していないため常に `http.Server` になる（`dist/index.mjs:638-646`）。仮に false になっても、`server.close()` が接続の終了を待って解決しないまま 2 秒でタイムアウト → warn → CLI が `process.exit(0)`、という挙動になる。これは V-10 で実測した「close が永久に解決しない」ケースそのもので、**AC-1 は保たれる**。型述語化自体は `in` ナローイングより意図が明確で妥当。

- **[N-007]** `close()` の memo 化（`closePromise ??=`、`src/server/index.ts:210-216`）は、`ServerInstance.close` が削除されて `shutdown()`（それ自体 memo 済み）からしか呼ばれなくなったため、**現状では常に 1 回しか呼ばれず memo は発火しない**。listen エラー経路は `close` の定義より前で `reject` するので競合もしない。害はないが、コメント（「calling `server.close()` twice makes the second callback fail with ERR_SERVER_NOT_RUNNING」）は「起きうる問題」ではなく「起こさないための予防」であることが読み取りにくい。`shutdown()` の memo と二重になっている旨を一言添えるとよい。

- **[N-008]** AC-1 の「exit code 0」は、**stdout が壊れたパイプの場合だけ成立しない**（PR: exit 1 / base: exit 1、V-17）。原因は `console.log()`（`src/index.ts:178`、この PR 以前から存在）に対する**非同期の EPIPE 'error' イベント**で、`try/catch` でも `finally` でも捕捉できない（uncaught exception 扱い → exit 1）。`process.exit(0)` には到達しないがプロセスは必ず終了する。plan / ADR-007 が stdio drain を不採用にした判断とも整合しており、**この PR による回帰ではない**。`outro()` や `logger.warn` が同期 throw する経路（例: 将来 `@clack/prompts` が投げるようになる）についても同様に `process.exit(0)` を飛ばすが、シグナルハンドラの promise が unhandled rejection になって Node が exit 1 で落とすため、**ハングはしない**。「必ず exit 0」を厳密に保証したいなら、ハンドラ全体を `try { … } finally { process.exit(0) }` で囲む余地はある（ただし上記 EPIPE ケースは救えない）。

---

## 追加確認: 順序を入れ替えたら壊れる箇所

| 入れ替え | 壊れるか | 根拠 |
|---|---|---|
| 手順 1（`sse.shutdown()`）を手順 2 の後に | 壊れない（むしろ W-001 の推奨） | `shuttingDown` フラグでの新規拒否はリスナー閉鎖の前後を問わない |
| 手順 3（`watcher.close()`）を最後に | 壊れない | `sse.shutdown()` で `clients` が空になっているので `broadcast()` は no-op。新規 client も入れない（V-13/V-14）。**watcher close 後に broadcast が走る経路は残っていない** |
| 手順 4（`closeAllConnections()`）を手順 2 の前に | 壊れない（旧実装の順序） | どちらの順でも `_emitCloseIfDrained()` は `_connections` が 0 になった時点で発火する |
| 手順 5（`await withTimeout`）を手順 4 の前に | **壊れる** | `closeAllConnections()` が走らず SSE ソケットが残り、毎回 2 秒のタイムアウトに落ちる |
| `clients.clear()` を `for` ループの前に | **壊れる** | ループが空になり、接続中の client が `cleanup()` されないまま放置される |

`clients.clear()`（`sse.ts:42`）と ② 経路の `clients.delete(client)`（`sse.ts:60`）の順序は問題ない。`clear()` は `shutdown()` の同期ブロック内で完了し、② の `delete` は必ずその**後**の別ブロックで起きる（そもそも到達不能、W-004）。`for...of` 中に現在要素を `delete` するのも Set では安全。
