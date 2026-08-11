# Test Review #001

**Date:** 2026-07-25
**Round:** 1回目

---

## Summary

- Blockers: 1
- Warnings: 4
- Verdict: **BLOCKED**

---

## 検証方法

すべての指摘は、実装を意図的に壊して `vitest run` を走らせ、**落ちるべきテストが実際に落ちるか**を実測して確認した。実測に使った変異は毎回 `git checkout` で戻し、最終状態が `git status --porcelain` で clean・`pnpm test` で 266 passed であることを確認済み（末尾「最終確認」）。

環境: macOS / Node v22.22.1 / vitest 4.1.2。CI は `.github/workflows/ci.yml` により `ubuntu-latest` × Node 22 / 24 で `pnpm test` が回る。

---

### Test

#### Blockers

- **[B-001]** `shutdown-process.test.ts`（AC-1）は **`shutdown()` が永久に解決しない実装でも PASS する**。Issue の唯一の要件を担うテストが、その要件を判別できていない
  - 場所: `src/server/shutdown-process.test.ts:108-109`（`expect(result).toBe(0)` / `expect(elapsedMs).toBeLessThan(5_000)`）
  - 理由: 実測で確認した。`src/server/index.ts:239` の直前に `await new Promise(() => {});` を挿入して **`shutdown()` を無限ハングさせた状態**で `npx vitest run src/server/shutdown-process.test.ts` を実行すると `Tests 1 passed (1)` になる。同じ変異で子プロセスを直接観測すると:

    | 実装 | exit code | SIGINT→exit | 子プロセスの stdout 末尾 |
    |---|---|---|---|
    | 現行（正しい） | 0 | 6ms | `┌   Shutting down... ` → `└  Server stopped. Bye!` |
    | `shutdown()` が無限ハング | **0** | **6ms** | `┌   Shutting down... ` で終わり（`Server stopped. Bye!` **無し**） |

    原因は、`shutdown()` の同期部分（`sse.shutdown()` / `close()` / `watcher.close()` / `closeAllConnections()`）だけで **ref 付きハンドルが全部解放されるためイベントループが枯れ、`process.exit(0)` に到達しないまま Node が自然終了して exit code 0 になる**こと。つまりこのテストの `exit code 0` は「シャットダウンが完走した」証拠ではなく「ハンドルが枯れた」証拠にすぎない。これは計画自身が `unref()` 不採用の根拠として実測した現象（plan.md「設計」節の表 1 行目「1ms でプロセスが自然終了。警告も `outro()` も `process.exit(0)` も走らない（exit code 0）」）と同一だが、それが AC-1 のテストを空振りさせることは検討されていない。

    さらに、**このテストが本来ガードすべき「修正前の形」も検出できない**。`await withTimeout(closing, timeoutMs)` を素の `await closing` に戻し `closeAllConnections()` を無効化した（= Issue が報告した無限待ちの形）状態で計測すると **exit 0 / 4019ms** となり、5 秒閾値の内側に収まって PASS する（残マージン 981ms）。

    結果として、このテストが落ちるのは「10 秒経っても子プロセスが生きている」か「exit code が 0 以外」の場合だけであり、**AC-1 が主張する「`shutdown()` が有限時間で settle して正常終了する」という性質は一切検証されていない**。計画が 3 周かけて潰してきた「構造的に絶対落ちないテスト」と同種の欠陥が、要件充足を担う唯一のテストに残っている。
  - 提案: 子プロセスの出力に**シャットダウンハンドラが完走した証跡**が含まれることを assert する。`src/index.ts:187` は `await server.shutdown()` の後に `outro(pc.green("Server stopped. Bye!"))` → `process.exit(0)` の順で実行するため、この文字列の存在が「`shutdown()` が settle した」ことと等価になる。`shutdown-process.test.ts` は既に `output` を全部集めているので 1 行で足りる。

    ```ts
    expect(result, `Output:\n${output}`).toBe(0);
    expect(elapsedMs).toBeLessThan(5_000);
    // `outro()` は `await server.shutdown()` の直後・`process.exit(0)` の直前に出るので、
    // この行があることが「shutdown() が期限内に settle した」ことの証跡になる。
    // これが無いと exit code 0 はイベントループ枯渇による自然終了でも成立してしまう。
    expect(output, `Output:\n${output}`).toContain("Server stopped");
    ```

    判別性は実測で確認済み: 正常実装では `└  Server stopped. Bye!` が必ず出力され、無限ハング変異では出力されない（上表）。short write なのでパイプ越しでも欠落しないことは plan.md「リスクと注意点」で実測済みの事実と整合する（欠落は未 flush が 64KB を超える場合のみ）。

    あわせて、`exit code 0` が自然終了でも成立するという事実を **AC-1 の記述にも反映すべき**（現在の AC-1 は「exit code 0 で終了する」だけを条件にしており、テストと同じ穴を持っている）。

#### Warnings

- **[W-001]** `withTimeout` の `clearTimeout` を**丸ごと削除しても 7 ケース全部が PASS する**。計画が「`clearTimeout` の唯一の自動検証」と位置づけたケースが機能していない
  - 場所: `src/lib/with-timeout.test.ts:22-30`（`does not wait for the full budget when the promise settles early`）/ `src/lib/with-timeout.ts:55,59`
  - 理由: plan.md ステップ 2 に「期限内に解決した場合、タイマーが残らない（テストが `timeoutMs` 分ブロックしないこと自体で担保）。**`unref()` を使わないため、ここが `clearTimeout` の唯一の自動検証になる。**」と明記されているが、実測ではこれが成立しない。`src/lib/with-timeout.ts` から `clearTimeout(timer);` を 2 箇所とも削除して `npx vitest run src/lib/with-timeout.test.ts` を実行すると `Tests 7 passed (7) / Duration 271ms`（削除前 272ms と有意差なし）。成功側だけ削除した場合も同じく 7 passed。

    理由は明快で、`clearTimeout` を落としても **`withTimeout` が返す Promise の解決タイミングは 1ms も変わらない**（`resolve()` は既に呼ばれている）。残るのは ref 付きタイマーがイベントループに留まる副作用だけで、それはテストの assert 対象でも vitest のワーカー終了条件でもない。plan.md が根拠にした実測（「`clearTimeout` を落とすと completed 後も 303ms 生き残る」）は**スタンドアロンのプロセス終了時間**の計測であって、vitest のテストケースの所要時間ではない。この取り違えでカバレッジが実在すると誤認されている。

    `unref()` を採用しない判断（ADR-001 / アーキ S-201）は、`clearTimeout` が確実に効いていることに全面的に依存している。その唯一の保険が空振りしている。
  - 提案: どちらかを選ぶ。
    1. 実際にタイマーの生存を観測するケースを足す。`process.getActiveResourcesInfo()`（Node 17+、CI の Node 22/24 で利用可）で `withTimeout` 前後の `"Timeout"` 件数の差が 0 であることを assert する。実測で判別性を確認すること。
    2. カバレッジが無いことを認め、plan.md ステップ 2 と `with-timeout.ts` の doc コメント（`clearTimeout` alone is what prevents the timer from delaying teardown）の記述を「自動テストでは担保していない」に訂正する。

    どちらでもよいが、**「担保されている」という現在の記述のまま残すのが一番まずい**。

- **[W-002]** 本 PR の構造的修正の中核である「`close()` を `closeAllConnections()` より**先**に呼ぶ」順序（ADR-002）に、**回帰ガードが 1 つも無い**。AC-4 のテストの判別窓も ~10ms 幅しかなく、コメントが主張する範囲を検証できていない
  - 場所: `src/server/index.test.ts:100-109`（`stops accepting connections before shutdown() is awaited`）/ `src/server/index.ts:227-236`
  - 理由: 2 つ実測した。
    - **順序を元に戻しても全テスト緑**: `src/server/index.ts` で `const closing = close();` を `closeAllConnections()` の**後ろ**に移動（= plan.md「設計」節の「1 → 2 → 4 の順が肝」を破棄）しても、`index.test.ts` + `shutdown-process.test.ts` は `Tests 9 passed (9)`。1〜4 が全部同期なので AC-4 のテストは影響を受けない。plan.md は AC-4 を「再発防止（Issue 修正案 1）」の検証と位置づけているが、実際に守られているのは「同期ブロック中にリスナーが閉じる」ことだけで、**修正案 1 の本体である順序そのものは無検証**。
    - **判別窓は 0〜10ms**: `close()` の直前に遅延を入れて計測したところ、`await Promise.resolve()`（マイクロタスク）→ 3/3 PASS、`await new Promise(r => setTimeout(r, 0))` → 3/3 PASS、`setTimeout(r, 10)` → 5/5 FAIL、`setTimeout(r, 100)` → 3/3 FAIL。テストのコメント「The listener is closed before the first `await` inside shutdown().」が主張するのは「最初の `await` の前」だが、実際に検出できるのは「テスト側の `fetch()` が TCP connect に到達するまで（実測 0〜10ms）に閉じているか」でしかない。CI（`ubuntu-latest`、負荷変動あり）ではこの窓がさらに広がり、判別性は落ちる方向にしか動かない。

    なお false-red 方向の心配は無い（現行実装は同期で `close()` を呼ぶので必ず接続拒否になる）ので、flaky にはならない。問題は**検証範囲がコメントの主張より狭い**ことと、**順序という本命が無検証**であること。
  - 提案:
    - テストのコメントを実態に合わせる（「`shutdown()` から戻った直後の `fetch` が拒否されること」までしか言わない）。
    - 順序の回帰ガードが欲しいなら、`server.close` / `server.closeAllConnections` を `vi.spyOn` して呼び出し順（`close.mock.invocationCallOrder[0] < closeAllConnections.mock.invocationCallOrder[0]`）を assert するケースを 1 つ足す。`startServer` が返す `server` はクロージャ内なので直接は掴めないが、`@hono/node-server` の `serve` をモックするか、`shutdown()` の順序を検証可能な形に切り出す必要がある。コストが見合わないと判断するなら、**「ADR-002 の順序は自動テストで担保していない（レビューで確認する）」と plan.md のテスト方針「間接検証にとどまるもの」に明記する**だけでもよい。現在この節には AC-2 と AC-8 しか挙がっておらず、順序が抜けている。

- **[W-003]** AC-8 のテストで、body 読み捨て（3 周目に判別マージンを 1 → 6 に広げた要）が `if (reader)` の中に入っており、**`res.body` が `null` になった瞬間に無言で 3 周目以前の弱いテストに退化する**
  - 場所: `src/server/routes/sse.test.ts:170-182`
  - 理由: plan.md「AC-8 が証明する範囲」の表が示すとおり、body を読み捨てない形では手書き `sleep()` でも `[2,2,2,2,2]` にしかならず、判別は `max <= 1` の 1 差分に縮む。さらに plan.md 自身が「body を読まない形は Hono の `TransformStream` が書き込みを 1 件だけバッファする挙動に依存しており、Hono 側が変わると手書き `sleep()` でも `[1,1,...]` になって **false-green になりうる**」と書いている。にもかかわらず現在のコードは `const reader = res.body?.getReader(); if (reader) { ... }` で、`res.body` が無ければ何事もなかったかのように先へ進む。同じファイルの AC-7 のテスト（`sse.test.ts:110-111`）は `if (!reader) throw new Error("No reader");` と書いており、**同一ファイル内で流儀が割れている**のも読み手を惑わせる。
  - 提案: AC-7 と同じく fail-fast にする。

    ```ts
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No reader — the drain below is what gives this test its margin");
    void (async () => { ... })();
    ```

- **[W-004]** `getFreePort()` の TOCTOU が `shutdown-process.test.ts` では致命的に広い。ポート衝突時のエラーが 20 秒後の「起動しなかった」に化けて原因が読めない
  - 場所: `src/server/shutdown-process.test.ts:13-22, 86`
  - 理由: `getFreePort()` は「listen(0) → 即 close → その番号を返す」ので、返した瞬間からポートは誰でも取れる。既存の `index.test.ts` では `startServer()` が同一プロセス内で即 bind するので窓は数 ms だが、`shutdown-process.test.ts` は **`spawn` → tsx のトランスパイル → `initMarkdown()`（shiki）→ bind** まで待つので窓が桁違いに広い（macOS 実測で子プロセス起動 ~300ms、CI の cold start では数秒規模になりうる）。vitest はテストファイルを並列実行するので、この窓に `index.test.ts` 側の `getFreePort()` が同じ番号を引く可能性がある。

    そして衝突したとき、`src/index.ts:153` の `Port ${port} is already in use` で子プロセスが即死し、テスト側は `waitForServer(port, 20_000)` を 20 秒回してから `Server did not start within 20000ms` で落ちる。**収集済みの `output`（実際の原因が書いてある）は投げられないので、CI ログからは原因が分からない**。
  - 提案: `waitForServer` のポーリングループで子プロセスの終了を検知して即座に `output` 付きで失敗させる。

    ```ts
    // ループ内
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`peek exited before listening (code=${child.exitCode}).\nOutput:\n${output}`);
    }
    ```

    ポート衝突そのものを消したいなら `getFreePort()` に簡単なリトライ（bind 失敗なら別ポートで再試行）を入れる手もあるが、まずは**失敗したときに原因が読める**ことのほうが重要。

#### Notes

- **[N-001]** 判別性が実測で確認できたテスト（vacuous でないと確認済み）。すべて `git checkout` で復元済み。

  | 変異 | 対象テスト | 結果 |
  |---|---|---|
  | `delay()` → 手書き `sleep()` に復帰 | AC-8 `does not accumulate abort listeners per client` | **FAIL**。`counts = [0,2, 0,3, 0,4, 0,5, 0,6]` で `expect(counts).toContain(1)` が捕捉（plan.md の予測 `[2,3,4,5,6]` を再現） |
  | ② の再チェックを常に真にする（keep-alive 待機に到達しない） | AC-8 ほか計 4 ケース | **FAIL**。`expect(sse.clientCount).toBe(1)` が `+0` を捕捉。positive control が設計どおり働いている |
  | `cleanup()` から `abortController.abort()` を除去 | AC-7 `shutdown ends connected streams without waiting for the keep-alive interval` | **FAIL**。`expected 'expired' to be 'eof'`（561ms、500ms 閾値を超過） |
  | ① の 503 早期 return を無効化 | AC-5 `GET /sse after shutdown responds 503 without starting a stream` | **FAIL** |
  | `logger.warn` の呼び出しを削除 | AC-3 `warns when the server does not close within the budget` | **FAIL**。`expected "warn" to be called 1 times, but got 0 times` |
  | 警告条件を常に真にする | AC-3 `does not warn on a healthy shutdown with an open SSE connection` | **FAIL**。偽陽性ガードが機能している |
  | `!(timeoutMs > 0)` → `timeoutMs <= 0` | `treats NaN as a zero budget` | **FAIL**。`{ status: 'completed' }` を検出（アーキ S-202 の判断が実際に守られている） |
  | 予算ゼロ経路の `promise.catch(() => {})` を削除 | `does not produce an unhandled rejection ...` | **FAIL**。`[ Error: late, zero budget ]` を検出 |

  AC-8 の positive control（3 周目 P-201 の修正）は**実際に効いている**ことを確認できた。AC-7 の 500ms 閾値も、実測（正常 0ms / abort 除去 561ms 超）から見て CI で偽陽性を出す余地は小さい。

- **[N-002]** AC-6（`GET /sse after shutdown does not register a client`）は ① を無効化しても PASS する（② が拾うため）。これは設計どおり（plan.md「②は取りこぼさないための正しさの保証」）で問題ではないが、**AC-6 単独では ① の存在を証明しない**ことは認識しておくとよい。① の存在は AC-5 が担保している。

- **[N-003]** `shutdown()` 内の「`shuttingDown = true` を **先に**立ててから走査する」という順序（ADR-003 の中核）は自動テストで担保されていない。フラグを `clients.clear()` の後に立てても既存テストは全部通る。ただしこれは plan.md が「レースは現行コードでは成立しない（マイクロタスクが interleave しない）」と結論づけたうえでの構造対策なので、**再現条件を作れない以上テスト不能**であり妥当。W-002 と同様に、テスト方針の「間接検証にとどまるもの」節に 1 行足しておくと将来の読者に親切。

- **[N-004]** 後始末・安定性は良好。`pnpm test` を **5 回連続**実行して 5/5 で `266 passed (266)`（1.26〜1.39s）。実行後の `ps` で peek の残プロセス 0 件。AC-8 の `finally` は `sse?.shutdown()` → `vi.useRealTimers()` → `globalThis.AbortController` 復元を同一ブロックで行っており（アーキ S-204 の指示どおり）、実測でも同一ファイル後続ケースへの汚染は無い。`index.test.ts` の `vi.spyOn(console, "warn")` も両ケースとも `finally` で `mockRestore()` + `sse.body?.cancel()` されている。

- **[N-005]** AC-9（既存テストの回帰）は満たされている。`main` の 5 ケース（起動/解決/シャットダウン後の接続拒否/冪等/並行）はすべて残存。`closeAll` → `shutdown` の改名で意図が失われた箇所は無く、`closeAll resets clientCount to zero` は「その後の新規接続も登録されない」まで拡張されて強化されている。削除された `ServerInstance.close` / `sseCloseAll` を使っていたテストは `main` に存在しない（`git grep` で確認）。

- **[N-006]** AC-8 のテストのコメントは、**なぜ body を読み捨てるのか**（Hono の `TransformStream` のバックプレッシャーでループが 1 周で止まりリークが線形に現れない）、**なぜ positive control が要るのか**（Hono 内部の `AbortController` が混ざるため 0 で緑になる）、**何を証明していないのか**（N 回完了後のリーク不在ではない）が 3 点とも書かれており、将来壊れたときに意味を読み取れる。実測値の表がコメントに埋め込まれているのも良い。可読性・意図の伝達は十分。ただし W-003 の 1 点だけが「コメントの主張とコードの強度がずれている」箇所。

- **[N-007]** fake timers への依存の脆さについて。AC-8 は 3 周目の修正で「vitest の fake timers が `node:timers/promises` を駆動しない」という非対称性から独立している（plan.md 表の (d)）。仮に将来 vitest が `node:timers/promises` を駆動するようになっても、`node:timers/promises` の `delay()` は待機終了時に abort リスナーを外すので `counts` は `[1,1,...]` のままで **false-red にも false-green にもならない**。逆に手書き `sleep()` が再導入された場合は駆動の有無にかかわらず線形増加するので FAIL する。この点の設計は健全。

- **[N-008]** `stream.write(...)` から `.catch(cleanup)` を削除した変更（Hono の `StreamingApi.write()` が例外を握りつぶすためデッドコード）は自動テストで担保されていないが、これは「削除された処理が実行されないこと」の検証であり、そもそもテスト可能な観測点が無い。コード内コメントで根拠が残されており妥当。

---

## 最終確認

```
$ git status --porcelain
(出力なし = clean)

$ pnpm test
 Test Files  27 passed (27)
      Tests  266 passed (266)
```

検証用の変異はすべて `git checkout` で復元済み。使い捨てファイルはリポジトリ外（scratchpad）にのみ作成し、リポジトリには残していない。
