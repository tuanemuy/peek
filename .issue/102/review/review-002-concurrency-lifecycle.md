# Concurrency & Lifecycle Review #002

**Date:** 2026-07-25
**Round:** 2回目
**対象:** PR #116 (`issue/102/fix-shutdown-hang` @ `b8e5da3`) / base `46cc093`

---

## Summary

- Blockers: 0
- Warnings: 2
- Notes: 6
- Verdict: **APPROVED**

1 ラウンド目の指摘に対する修正はどれも「並行制御の構造」を触っているが、**新たなハング経路・unhandled rejection・リグレッションは検出できなかった**。`close()` を手順 1 に移した順序変更、`Promise.withResolvers()` による再入ガード、エラー分離（try/catch + rethrow）はいずれも実測で成立を確認した。指摘 2 件はいずれも「今日は到達しないが、修正が掲げた不変条件を実際には達成していない／達成の仕方が粗い」というレベルであり、マージを止めるものではない。

---

## 検証方法（この結論の根拠）

`b8e5da3` を detached worktree（`scratchpad/wt-conc-r2`）にチェックアウトし、フォールト注入を含めて実際に走らせて確認した。**メインの作業ツリーは一切変更していない**（本ファイルの書き込みを除く）。作業後 worktree は削除済み。Node v22.22.1 / macOS。

| # | 検証内容 | 結果 |
|---|---|---|
| V-1 | `vitest run` / `tsgo` / `biome check src` | 27 files / **268 tests pass**、typecheck 0 error、lint 0 |
| V-2 | `Promise.withResolvers` を **engines の下限 Node 22.0.0** で確認（`npx node@22.0.0`） | `v22.0.0 withResolvers=function`。`tsconfig` の `target`/`lib` = `ES2024` で typecheck も通る |
| V-3 | 再入ガード: `const p1 = s.shutdown(); const p2 = s.shutdown();` | `p1 === p2` が **true**（deferred 先行代入が効いている） |
| V-4 | AC-4: `shutdown()` から戻った**直後**に生 TCP connect | `ECONNREFUSED`。フォールト注入 6 パターン全てで同じ |
| V-5 | **手順 2（`sse.shutdown()`）に throw を注入** | SSE 無し: 1ms で reject。SSE 有り: **803ms（予算 800ms）で warn → reject**。2 回目の `shutdown()` は同じ rejected promise。unhandled rejection 0 |
| V-6 | **手順 3（`watcher.close()`）に throw を注入** | 同上（SSE 有りで 803ms、warn + rethrow、unhandled 0） |
| V-7 | 実 CLI + 実 SIGINT + 手順 2 throw 注入 | **exit 0 / 2024ms**、`did not close within 2000ms` と `Failed to shut down server: injected sse.shutdown failure` の両方を出力後 `Server stopped. Bye!` |
| V-8 | 実 CLI + 実 SIGINT + `server.close()` が**永久に解決しない**注入 | **exit 0 / 2020ms**、warn 出力あり |
| V-9 | 実 CLI + 実 SIGINT + `close()` が**同期 reject** する注入 | **exit 0 / 6ms**、`Failed to shut down server` |
| V-10 | 実 CLI + SIGINT 2 回（hang 注入下） | **exit 1 / 315ms**、`Force exiting...`。force exit 経路は健在 |
| V-11 | `server.close(cb)` の cb は `closeAllConnections()` **より前**に発火しうるか | **しえない**。接続 0 でも接続有りでも `sync-after-close -> sync-after-closeAllConnections -> close-cb`（`_emitCloseIfDrained` は `process.nextTick`） |
| V-12 | `withTimeout` タイムアウト後に元 promise が reject / 予算ゼロで reject | 両方とも **unhandled rejection 0**（1 周目 V-2 の再確認） |
| V-13 | `sse.ts` の `onAbort` / `clients.add` の間に **人工的な `await` を注入**し、その窓で abort | **`clientCount` が 1 のまま残る（リーク）**。詳細は W-001 |
| V-14 | 同上の窓で `sse.shutdown()` を呼んだ場合 | `clientCount` = 0。②の再チェックは `shuttingDown` については機能する |
| V-15 | `if (!closed) clients.add(client)` に変えて V-13 を再実行 | `clientCount` = 0（W-001 の提案が実際に効くことを確認） |
| V-16 | `startServer` の `onError` リスナー内で throw した場合 | `uncaughtException` になり `reject(err)` に到達しない（ハングではなくクラッシュ）。N-004 |
| V-17 | 削除 API (`ServerInstance.close` / `watcher` / `sseCloseAll`) の残参照 | grep + typecheck で 0 件 |

---

## 1ラウンド目指摘の解消状況

- **[W-001] `close()` を手順 1 に / 手順間のエラー分離** — **解消**。`src/server/index.ts:220` で `const closing = close();` が手順 1 になり、手順 2〜4 は `try { … } catch (error) { failure = { error }; }`（224-242 行）で分離され、手順 5 の有界待機の**後**に `throw failure.error`（251-253 行）。`closing` は throw の有無にかかわらず必ず `withTimeout` に渡る。V-5〜V-7 で実測（手順 2 / 手順 3 に throw 注入 → 有界に settle し、CLI が catch して exit 0）。捕捉を `{ error: unknown } | undefined` に包む形も正しく、`undefined` を throw されても `failure` は truthy なので取り違えない。
- **[W-002] 再入ガードが手順 1〜4 の間は無効** — **解消**。`Promise.withResolvers<void>()` の deferred を `shutdownPromise` に**先に**代入してから `runShutdown()` を呼ぶ形（`src/server/index.ts:266-269`）。executor は同期実行なので代入は `runShutdown()` の呼び出し前に完了する。V-3 で `p1 === p2` を実測。`Promise.withResolvers` は engines の下限である Node 22.0.0 で利用可能（V-2 で実バイナリ確認）、`lib: ES2024` で型も通る（V-1）。AC-4 も壊れていない（V-4）。
- **[W-003] `stream.onAbort()` を `clients.add()` より前に** — **部分的**。並びは入れ替わった（`src/server/routes/sse.ts:78-79`）が、**その並べ替えが謳っている不変条件は達成されていない**。詳細は本ラウンドの W-001。提案の後半（②を `shuttingDown` 以外にも広げる）は未採用。
- **[W-004] ②のコメント（到達不能の明記 / 「the response was already handed back」の事実誤り）** — **解消**。`src/server/routes/sse.ts:81-90` は「Unreachable today — Hono runs this callback synchronously up to the first `await`」と明記し、誤った理由づけは `streamSSE` がステータス／ヘッダを自分で決めるという正しい説明に差し替わっている。
- **[W-005] 手順 4 のコメントが Node 19+ の事実と食い違う** — **解消**。`src/server/index.ts:230-233` が「`server.close()` takes care of the idle keep-alive ones itself (Node >= 19 calls `closeIdleConnections()` from within `close()`)」に修正され、`closeAllConnections()` の必要性が active ソケットに限定されている。実装 (`http.Server.prototype.close` → `httpServerPreClose`) と一致することを本ラウンドでも確認した。
- **[W-006] テストの `shutting` がフローティング** — **解消**。`src/server/index.test.ts:110` に `shutting.catch(() => {});` が入り、なぜ必要かのコメントも付いた。新規追加された順序回帰テスト（`index.test.ts:193`）でも同じ形が守られている。

---

### Concurrency & Lifecycle

#### Blockers

なし。

#### Warnings

- **[W-001]** `stream.onAbort(cleanup)` を `clients.add(client)` の前に移しても、**謳っている「client が `clients` に残り続ける」窓は塞がっていない**。コメントの主張が事実と一致していない
  - 場所: `src/server/routes/sse.ts:75-79`（コメント）、`79`（`clients.add(client)`）
  - 理由: コメントは「`StreamingApi.abort()` は登録済みリスナーにしか通知しないので、2 つの間に abort が landing すると **this client in `clients` forever** になる。だから subscribe を先にする」と書いている。しかし新しい順序で同じ窓（＝将来 2 行の間に `await` が入った場合）に abort が landing すると、
    1. `cleanup()` が発火 → `closed = true` → `clients.delete(client)` は **client がまだ Set に入っていないので空振り**
    2. 窓から復帰 → `clients.add(client)` が**死んだ client を登録する**
    3. ②の再チェックは `shuttingDown` しか見ないので素通り、`while (!closed)` は `closed === true` なので即抜け
    → **client は `clients` に永久に残る**。つまり "in `clients` forever" は解消されていない。
  - 実測（V-13 / V-14 / V-15、`onAbort` と `add` の間に `await delay(50)` を人工注入して計測）:

    | 順序 | 窓の中で abort | 窓の中で `sse.shutdown()` |
    |---|---|---|
    | 旧（`add` → `onAbort`） | `clientCount` = **1** | — |
    | 新（`onAbort` → `add`、本 PR） | `clientCount` = **1** | `clientCount` = 0 |
    | `if (!closed) clients.add(client)` | `clientCount` = **0** | `clientCount` = 0 |

  - 改善はしている（旧順序では `closed` が false のままなので keep-alive ループが 30 秒周期で回り続ける。新順序ではループは止まる）。しかし **`clients` のリーク自体は残っており、ADR-003 の「順序を入れ替えるだけでこの窓が消える（コストゼロ）」および実装コメントは事実と異なる**。SSE の再接続はブラウザが繰り返すので、この窓が実在するようになった場合のリークは単調増加する（`broadcast()` が空振りの `send()` を回す分だけ遅くなる）。
  - なお **今日この窓は存在しない**（`onAbort` と `add` の間に `await` は無く、`streamSSE` は `run(stream, cb)` を `c.newResponse()` **より前**に同期呼び出しするので、`cb` の同期部分の実行時点で `abort()` の発火源がまだ存在しない）。実測でも窓なしでは新旧どちらも `clientCount` = 0 で、**main からの回帰ではない**。
  - 提案（いずれか）: (a) `clients.add(client)` を `if (!closed) clients.add(client);` にする（V-15 で有効性を実測、1 行）。(b) 順序変更をこのまま残すなら、コメントと ADR-003 を「abort が窓に入った場合でも keep-alive ループは止まる（`clients` からの除去は別途 ② と `!closed` ガードが要る）」という**実態どおりの記述**に直す。現状は「塞いだ」と読めるコメントだけが残っており、次の読者を誤らせる。

- **[W-002]** 手順 2〜4 を**ひとつの** `try` にまとめたため、手順 2 の throw が手順 4（`closeAllConnections()`）を巻き添えにする。`closeAllConnections()` は「有界待機に落ちずに速く終わる」ことを担保している唯一の手順なので、分離の粒度が目的と合っていない
  - 場所: `src/server/index.ts:224-242`
  - 理由: エラー分離の目的は「何が失敗しても手順 5 の有界待機は必ず行う」であり、それは達成されている。しかし副作用として、手順 2 が throw すると手順 3・4 がスキップされる。手順 4 が飛ぶと **送信中の SSE を抱えた active ソケットが destroy されず、`server.close()` は解決しない → 毎回タイムアウト予算をフルに消費する**。実測（V-5 / V-7）: SSE 接続 1 本の状態で手順 2 に throw を注入すると `shutdown()` は **803ms（予算 800ms）**、実 CLI では **2024ms** かかり、`did not close within 2000ms` の警告が出た（SSE 無しなら 1ms）。加えて `ServerInstance` から `close` / `watcher` が削除された（ADR-005）ため、**取り残されたソケットと watcher を後始末する手段は呼び出し側に一切残っていない**。
  - AC-1（必ず終了する）は壊れていない（CLI が `process.exit(0)` する）。問題は「本 PR が消そうとしている『たまたま throw しないから速い』依存」がここに残っている点で、W-001（1 周目）が指摘したのと同じ構造である。
  - 提案: 手順 4 を独立した `try` にする（`closeAllConnections()` は Node 実装上 throw しないので、実質は「手順 2/3 の失敗に引きずられない」ことの明示）。あるいは 3 手順それぞれを個別に捕捉して最初のエラーだけ保持する。少なくとも「手順 2 が throw すると手順 4 が飛び、有界待機の予算をフルに使う」ことをコメントに残すべき。

#### Notes

- **[N-001]** **新しい手順順序（`close()` が手順 1）そのものに問題は見つからなかった。** `server.close(cb)` の `cb` は `net.Server.prototype._emitCloseIfDrained()` が `process.nextTick` で `emitCloseNT` を回す経路でしか呼ばれないため、**同期ブロックである手順 2〜4 より前に発火することは原理的にありえない**。実測（V-11）でも接続 0 本・接続 1 本のどちらでも `close() → closeAllConnections() → close-cb` の順だった。仮に発火したとしても `closing` は既に promise 化されており `withTimeout` に渡るだけなので害はない（`index.test.ts` の順序回帰テストのスタブは `cb` を**同期呼び出し**しており、その形でもテストは通る）。`close()` 後の `closeAllConnections()` も `this[kConnections]` を走査するだけで throw しない。手順 1 を先にしたことで「シャットダウン後の `/sse` が 503 に到達する前に TCP で拒否される」（1 周目 N-004）という性質も維持されている。

- **[N-002]** `Promise.withResolvers` の reject 経路で unhandled rejection は起きない。`runShutdown()` は async 関数なので同期 throw せず、`.then(resolve, reject)` の派生 promise は `reject` が正常 return するため常に fulfilled になる。deferred 側の `promise` は `shutdown()` が**同期的に**呼び出し側へ返すので、`await` / `.catch()` を張る機会が必ず先に来る。実測（V-5 / V-6）でもフォールト 6 パターンすべてで unhandled rejection 0。ただし `shutdown()` を fire-and-forget する呼び出し方だけは従来どおり呼び出し側の責任（現状そのような呼び出しはリポジトリ内に無い）。

- **[N-003]** `shutdownPromise` は **rejected な promise も恒久的に memo される**。1 回目が失敗した後は何度呼んでも同じエラーで reject し、リトライは起きない（実測: 2 回目も同じ `injected ... failure`）。`ServerInstance.shutdown` の doc（「Idempotent — later calls return the promise of the first one」）どおりの契約であり、CLI 側は 2 回目の SIGINT を `shuttingDown` フラグで force exit に回すのでハングにはならない（V-10）。意図どおりだが、「失敗しても再試行されない」ことは doc から読み取りにくい。

- **[N-004]** `startServer` の listen エラー経路（`src/server/index.ts:195-200`）には**エラー分離が無い**。`sse.shutdown()` / `watcher.close()` が `reject(err)` より前にあるため、そこで throw すると `startServer()` の promise は永久に settle しない。実測（V-16）では `'error'` リスナー内の throw は `uncaughtException` になってプロセスが落ちる（exit 1）ので**ハングにはならない**が、`src/index.ts:149-157` の `EADDRINUSE` → 「Port N is already in use」という整形済みメッセージ経路は飛ばされ、生スタックトレースが出る。今日は両関数とも throw しない（`FSWatcher.close()` と `clearTimeout` のみ）。`shutdown()` 側に分離を入れた以上、同じ基準をここにも当てるなら `try { … } finally { reject(err); }` で十分。

- **[N-005]** `ServerInstance` からの `watcher` 削除に問題は無い。`.watcher` / `sseCloseAll` / `.close` の残参照は grep で 0 件、typecheck も通る（V-17）。watcher のライフサイクルは `runShutdown()` のクロージャと listen エラー経路の 2 箇所だけが握る形になり、`shutdown()` が呼ばれずにプロセスが終わる経路（CLI がシグナルハンドラ登録前に throw する等）では**プロセス自体が終了する**のでリークにならない。`closePromise` の memo（`index.ts:207-213`）と listen エラー経路が競合しないことも変わらず成立している（`close` の定義は listen 待ちの `await` より後にあるため、エラー経路は `close` が存在する前に reject する）。ただし 1 周目 N-007 と同じく、`close()` の呼び出し元が `runShutdown()` 1 箇所だけになったため **この memo は実際には一度も発火しない**（`shutdown()` 側の memo と二重）。害は無いが「予防」であることがコメントから読み取りにくい点も 1 周目のまま。

- **[N-006]** ドキュメントの追随漏れ 2 件（並行性の判断そのものには影響しない）。(a) `adr.md` は手順順序を変更したのに、ADR-002 の Consequences（「リスニングハンドルは手順 2 で閉じるため」）と ADR-003（「`server.close()` をシャットダウン冒頭（ADR-002 の手順 2）で呼ぶため」）が**旧番号のまま**で、現行の手順 2 は `sse.shutdown()` を指してしまう。(b) `plan.md` の AC-3（23-26 行目付近）と 298 行目は、ADR-008 で廃止された `shutdown({ timeoutMs: 0 })` の API を前提に書かれたままで、実装（`startServer(config, { shutdownTimeoutMs: 0 })`）とずれている。テストは新 API に追随済み（`index.test.ts:121-126`）。

- **[N-007]** 1 周目の N-005（`await stream.write(": keep-alive\n\n")` がバックプレッシャー下で無期限 pending になりうる）は本 PR では変わっていない。`closeAllConnections()`（手順 4）でソケットが destroy されれば `@hono/node-server` の `writable.on("close", cancel)` 経由で解けるので**ハング要因にはならない**が、W-002 のとおり手順 2/3 が throw して手順 4 が飛んだ場合はこの解け方も失われる（有界待機がそれを吸収する）。

---

## 受け入れ基準の判定（担当観点分）

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1 | ✅ | V-7 / V-8 / V-9 / V-10。close 永久保留・手順 throw・close 同期 reject のいずれでも exit 0（2024ms / 2020ms / 6ms）。2 回目 SIGINT の force exit も健在 |
| AC-2 | ✅ | V-8（永久保留の close 注入で 2020ms）。`runShutdown()` の唯一の待機点が `withTimeout` であることをコードで確認、かつ `closing` は throw 経路でも必ず渡る（V-5 / V-6） |
| AC-3 | ✅ | `index.test.ts:121-139` が新 API（`startServer(..., { shutdownTimeoutMs: 0 })`）で warn を 1 回検証。偽陽性なしも `141-155` で検証。実タイマー経路も V-7 / V-8 で確認 |
| AC-4 | ✅ | V-4（フォールト注入 6 パターン全てで `ECONNREFUSED`）。`close()` が `runShutdown()` の第 1 文になったことで、最初の `await` 前のリスナー閉鎖が他手順の成否から独立した。`index.test.ts:167-203` の順序回帰テストが構造として固定している |
| AC-5 / AC-6 | ✅ | `sse.test.ts` の 503 / `content-type` / `clientCount` 検証。V-14 で②の `shuttingDown` 再チェックが窓ありでも機能することを確認 |
| AC-7 | ✅ | `sse.test.ts:105-129`（500ms 以内に EOF）。ただし N-007 の穴は残る |
| AC-8 | ✅ | `sse.test.ts:148-210`。positive control 付きで vacuous pass しない形になっている |
| AC-9 | ✅ | V-1（268 tests pass） |

---

## 片付け

検証に使った worktree（`scratchpad/wt-conc-r2`）は `git worktree remove` で削除済み。フォールト注入はすべてその worktree 内で行い、メインの作業ツリー（`/Users/hikaru/github.com/tuanemuy/peek`）のソースは一切変更していない。
