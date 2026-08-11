# Test Review #003

**Date:** 2026-07-25
**Round:** 3回目

---

## Summary

- Blockers: 0
- Warnings: 1
- Verdict: **APPROVED**

---

## 検証環境と方法

隔離した git worktree（`--detach` で `5a44ecd`）に `pnpm install --frozen-lockfile` して検証した。メインの作業ツリーは本ファイル以外一切触っていない。すべての指摘・確認は**実装を意図的に壊して `vitest run` を走らせ、落ちるべきテストが実際に落ちるか**を実測している。変異は毎回 `git checkout -- src/` で復元し、最終状態が `git status --porcelain` で clean であることを確認した（末尾「最終確認」）。

環境: macOS (darwin 25.4.0) / Node v22.22.1 / vitest 4.1.10 / pnpm 10.34.5 / 8 コア。CI は `.github/workflows/ci.yml` で `ubuntu-latest` × Node 22 / 24（`lint` → `format:check` → `typecheck` → `test` → `build`）。

ベースライン: `Test Files 27 passed (27) / Tests 271 passed (271)`。`pnpm typecheck` / `pnpm lint` / `pnpm format:check` もすべて緑（`Checked 109 files. No fixes applied.`）。

---

## 2ラウンド目指摘の解消状況

- **[W-001] 解消** — 「手順 2〜4 のエラー分離に回帰ガードが 1 つも無い」は `describe("shutdown error isolation")` の 3 ケースで完全に塞がった。R2 で「268 passed のまま通ってしまう」と実測した 2 つの変異は、いずれも**今は落ちる**:

  | 変異 | R2 の結果 | R3 の結果 |
  |---|---|---|
  | `step()` の try/catch を撤去 | 268 passed | **3 failed** — `expected [ 'close', 'sse.shutdown' ] to deeply equal [ 'close', 'sse.shutdown', …(1) ]` ほか |
  | `throw failure.error`（現 `failures` の rethrow）を丸ごと削除 | 268 passed | **3 failed**（`rejectionOf` の「expected shutdown() to reject, but it resolved」で全ケース） |

  加えて、R2 が提案した「予算経過 + 警告 1 回」の判別線が**実際に効いていることを別の変異で確認した**。`failures` の throw を手順 5 の**前**に移す（= 手順は分離したまま、有界待機だけスキップする形。この PR が消そうとしている形そのもの）と:

  ```
  × runs the later steps and the bounded wait even when an earlier step throws
    AssertionError: expected 0 to be greater than or equal to 25
  ```

  `calls` の配列比較では捕まらず、`elapsedMs` の 1 行だけが捕捉している。R2 の提案がそのまま機能している。

- **[W-002] 解消** — 予算と孤児化の両方が直った。

  - **予算**: `STARTUP_TIMEOUT_MS 10s` / `SSE_CONNECT_TIMEOUT_MS 5s` / `EXIT_TIMEOUT_MS 5s`。最悪ケースは `10s + 1s(in-flight fetch) + 150ms(poll) + 5s + 5s = 21.15s`（テスト冒頭のコメントの「≈ 21.2s」と一致）。`testTimeout: 30000` に対し **8.85s の余裕**。`fetch('/sse')` にも `AbortSignal.timeout(5_000)` が付いた（R2 で指摘した無制限 fetch）。
  - **孤児化**: ファイルスコープ `spawned` + `afterEach` の SIGKILL を**実測で検証した**。`src/index.ts` のシャットダウンを永久ハング（`setInterval` + `await new Promise(() => {})`）にして:

    | 実行 | 結果 | 子プロセス |
    |---|---|---|
    | `vitest run --testTimeout=3000`（現状） | 3.23s で FAIL（vitest のタイムアウト） | **残らない**（`ps -eo pid,command \| grep __test_shutdown_fixture__` が空） |
    | 同上・`afterEach` の `kill("SIGKILL")` だけを潰した対照実験 | 3.16s で FAIL | **残る** — `pid 41630 node ... src/index.ts .../__test_shutdown_fixture__ --port 54772 --no-open` が生存（手動 `kill -9` が必要だった） |
    | `vitest run`（既定 30s） | 5.49s で FAIL、`Error: peek did not exit after SIGINT.` + 出力全文 | 残らない |

    フックが実際に効いていること（=「書いてあるだけ」ではないこと）を対照実験で確認済み。診断メッセージも既定設定では失われない。

**2 件とも解消。再指摘なし。**

---

### Test

#### Blockers

なし。

#### Warnings

- **[W-001]** シャットダウン**手順 3（`watcher.close()`）だけが両方向で無検証**。手順を丸ごと消しても 271 passed で、`calls` の `toEqual` は網羅に見えて実際には手順 3 を含んでいない
  - 場所: `src/server/index.ts:235`（`step(() => watcher.close());`）/ `src/server/index.test.ts:170-179`（`withStubbedServer` の docstring）/ `:270`・`:306-310`・`:343`（`calls` の `toEqual`）
  - 理由: 実測した。`step(() => watcher.close());` を丸ごとコメントアウトしても **`Tests 271 passed (271)`**。他の 3 手順はすべて捕捉される（手順 1 の移動 → 3 failed / 手順 2 の削除 → 3 failed / 手順 4 の削除 → **6 failed**、プロセステストの `expected 2379 to be less than 2000` を含む）ので、**穴は手順 3 だけ**である。

    問題は 2 つある。

    1. **`calls` の `toEqual` が完全網羅に見える。** `expect(calls).toEqual(["close", "sse.shutdown", "closeAllConnections"])` は「shutdown の手順を順序込みで固定した」と読めるが、実際に固定しているのは 4 手順のうち 3 手順である。`withStubbedServer` の docstring も「**recording each shutdown step in `calls`** as it runs」と書いていて事実と一致していない（手順 3 は記録されない）。`ServerInstance.shutdown` の doc は「Stops everything: the HTTP listener, SSE streams **and the file watcher**」と明示しているので、契約のうち 1/3 が無検証のまま残っている。
    2. **エラー注入の対象も手順 2 と 4 だけ。** 新規 3 ケースが throw させるのは `sse.shutdown()`（実装は `Set` を走査するだけで実質 throw しない）と `closeAllConnections()` である。**実運用で最も throw しうるのは chokidar の `FSWatcher.close()`**（手順 3）だが、そこには注入口が無い。「どの手順が throw しても後続と有界待機が走る」という ADR-002 の主張のうち、最も現実的な 1 経路だけが検証されていない。

    これは R2 の W-001 と**同じ構図**である。R2 で問題にしたエラー分離も ADR 自身が「そもそもこの経路は現状のコードでは到達しない」（`adr.md:214`）と書いている性質のもので、それでも回帰ガードを足す判断をした。手順 3 だけを外す理由が無い。
  - 提案: `ShutdownStubs` に `onWatcherClose?: () => void` を足し、`withStubbedServer` に `vi.doMock("../lib/watcher.js")` を 1 つ増やして `calls.push("watcher.close")` するだけでよい（既存の SSE スタブと同型、**~12 行**）。これで
    - `calls` の期待値が `["close", "sse.shutdown", "watcher.close", "closeAllConnections"]` になり、docstring の主張と実体が一致する
    - 手順 3 の削除が落ちるようになる
    - 3 ケース目あたりに `onWatcherClose` の throw を 1 つ混ぜれば、実運用で最もありうる失敗経路が回帰ガードに載る

    コストが見合わないと判断するなら、`withStubbedServer` の docstring を「手順 1 / 2 / 4 を記録する（手順 3 は観測しない）」に直したうえで、plan.md の「間接検証にとどまるもの」に 1 行明記すること。**「担保されている」と読めるコメントだけが残る状態が一番まずい**のは R1 / R2 と同じ。

#### Notes

- **[N-001]** **`clients.add` の `!closed` ガードと `onAbort` 登録順には回帰ガードが無いが、これは自動テストで書けない性質のものなので妥当。** 実測: `if (!closed) clients.add(client)` を `clients.add(client)` に戻しても **271 passed**、`stream.onAbort(cleanup)` を `clients.add(client)` の後ろに移しても **271 passed**。

  ただしこれは「テストが弱い」のではなく**現行 Hono では到達不能**だからである。`node_modules/hono/dist/utils/stream.js` を読んで確認した:
  - `onAbort(listener)` は `abortSubscribers.push(listener)` するだけで、既に `aborted` でも即時発火しない
  - `abort()` は `aborted` をラッチし、その時点の購読者にしか通知しない
  - `stream.abort()` の唯一の到達経路は `responseReadable` の `cancel` フック（`isOldBunVersion()` 分岐は該当せず）。`streamSSE` は `run(stream, cb)` を呼んでからレスポンスを返すので、cancel はコールバックの同期部より後にしか走れない

  → `stream.onAbort(cleanup)` と `if (!closed) clients.add(client)` の間に `await` は無く、`closed` がその位置で真になる経路は今日は存在しない。窓を作るには production 側に人工的な `await` を入れるしかなく、それは `adr.md:253-259` が既にフォールト注入で実測している（`add`→`onAbort` = 1 / `onAbort`→`add` = 1 / 採用形 = 0）。R2 の N-004（`Promise.withResolvers` 化）と同じ扱いでよく、**テストを足すべきではない**。

  1 点だけ提案がある。同じファイルの②の再チェックには「**Unreachable today** — Hono runs this callback synchronously up to the first `await` — and kept so the guarantee survives an `await` appearing above」と到達不能である旨が明記されているのに、`!closed` ガード側のコメント（`sse.ts:75-79`）には無い。読者は「起きうる window を塞いでいる」と読むので、②と同じ 1 行を足すか、plan.md の「間接検証にとどまるもの」（現在 AC-2 と AC-8 の 2 項目だけ）に追記しておくと、将来「ここにテストが無いのは漏れでは？」という再指摘を防げる。

- **[N-002]** **plan.md が 3 ラウンド目の変更に追随していない**（AC カバレッジ自体の穴は無い）。
  - `plan.md:612` のテスト方針表は「実ポート + **`serve()` スタブ**」のままで、`SseManager.shutdown()` のスタブが増えたことが書かれていない
  - `plan.md:760`「AC-4 に手順順序テストを追加した」は期待値を `["close", "closeAllConnections"]` と書いているが、実際は `["close", "sse.shutdown", "closeAllConnections"]` の 3 要素
  - **`describe("shutdown error isolation")` の 3 ケースが、AC 表にもテスト方針表にも「テストの変更」節にも一切現れない。** R2 の W-001 に応えて足した最重要の回帰ガードなので、どこかに紐づけておかないと将来「この 3 ケースは何を守っているのか」が plan からは辿れない。AC を 1 本足す（例: AC-11「手順 2〜4 のいずれが throw しても、後続手順と有界待機は実行され、失敗は 1 件ならそのまま / 2 件以上は `AggregateError` で届く」）のが素直

- **[N-003]** **判別性の実測サマリ**（今ラウンドで実行した 17 変異。すべて `git checkout` で復元済み。◎ = 新規 3 ケースが捕捉）

  | # | 変異 | 結果 | 捕捉したテスト / メッセージ |
  |---|---|---|---|
  | M1 | `step()` の try/catch 撤去 | **3 failed** ◎ | `expected [ 'close', 'sse.shutdown' ] to deeply equal […(1)]` / `expected Error: socket boom to be an instance of AggregateError` |
  | M2 | `failures.length === 1` 分岐を潰す（常に `AggregateError`） | **1 failed** ◎ | `expected AggregateError… to not be an instance of AggregateError` |
  | M3 | `AggregateError` 分岐を潰す（`throw failures[0]`） | **2 failed** ◎ | `expected Error: sse boom to be an instance of AggregateError` |
  | M4 | 手順 5 の try/catch 撤去 | **1 failed** ◎ | `expected Error: close boom to be an instance of AggregateError` |
  | M11 | `failures` の rethrow を丸ごと削除 | **3 failed** ◎ | `expected shutdown() to reject, but it resolved`（`rejectionOf` の fail-fast が機能） |
  | M16 | `failures` の throw を手順 5 の**前**に移す | **2 failed** ◎ | **`expected 0 to be greater than or equal to 25`** — `elapsedMs` の 1 行だけが判別 |
  | M17 | `withTimeout` → 素の `await closing`（有界化撤去） | **2 failed** | AC-3 `warns when …` が **12ms** で捕捉 / 新テストも 30s の testTimeout で落ちる |
  | M6 | 手順 2（`sse.shutdown()`）を削除 | **3 failed** | 順序テスト + 新規 2 ケースの `calls` |
  | M8 | 手順 4（`closeAllConnections()`）を削除 | **6 failed** | プロセステスト `expected 2379 to be less than 2000` / `does not warn …` / `calls` 4 件 |
  | M15 | `close()` を `closeAllConnections()` の後ろへ | **3 failed** | `expected [ 'sse.shutdown', …(2) ] to deeply equal [ 'close', …]` |
  | M14 | `shutdownTimeoutMs` オプションを無視 | **1 failed** | AC-3 `expected "warn" to be called 1 times, but got 0 times` |
  | M10 | ①の 503 早期 return を削除 | **1 failed** | AC-5 `expected 200 to be 503` |
  | M12 | ②の再チェックを常に真 | **4 failed** | AC-6 / AC-8 ほか（positive control が機能） |
  | M13 | `cleanup()` から `abort()` を除去 | **1 failed** | AC-7 `expected 'expired' to be 'eof'`（557ms） |
  | — | `node:timers/promises` → 手書きリーク `sleep()` | **1 failed** | AC-8 `expected [ +0, 2, +0, 3, +0, 4, +0, 5, +0, 6 ] to include 1` |
  | — | `clearTimeout` 削除（成功側 / 失敗側） | **各 1 failed** | `expected 5 to be less than 5`（R1 で足した回帰ガードは健在） |
  | M7 | 手順 3（`watcher.close()`）を削除 | **271 passed** | → W-001 |
  | M5 | `clients.add` の `!closed` ガード除去 | **271 passed** | → N-001（構造的に到達不能） |
  | M9 | `onAbort` を `clients.add` の後ろへ | **271 passed** | → N-001（同上） |

  **「スタブの挙動だけを見ている」経路は見つからなかった。** `withStubbedServer` が差し替えるのは `serve()` の戻り値（`close` / `closeAllConnections`）と `SseManager.shutdown` の 2 点のみで、`startServer()` 本体・`runShutdown()` の手順並び・`step()` の捕捉・`failures` の集約・`withTimeout` はすべて実物が走る。判別しているのは実装側のプロパティであり、実際 M1〜M4 / M11 / M16 という**production 側の 6 変異すべてを捕捉した**。`rejectionOf()` が「resolve したら明示的に throw」する形になっているので、`await expect(...).rejects` にありがちな vacuous pass も無い。3 ケース目の `messagesOf()`（`(error as AggregateError).errors` への非安全キャスト）も、直前に `toBeInstanceOf(AggregateError)` があるため型が外れたら先に落ちる。

- **[N-004]** **新しい予算配分は CI でも十分に余裕がある**（実測）。

  | 計測点 | 通常 | **8 コアに 16 本の busy loop をかけた状態** | 予算 / 閾値 |
  |---|---|---|---|
  | 起動（spawn → `/` が 200） | 332 / 333 / 333 / 335 / 334 ms | 701 / 815 / 821 ms | `STARTUP_TIMEOUT_MS` 10,000ms |
  | SIGINT → exit | 5 / 6 / 7 / 7 / 7 ms | 12 / 15 / 14 ms | assert `< 2,000ms`、`EXIT_TIMEOUT_MS` 5,000ms |

  2 倍オーバーサブスクライブでも起動は **12 倍のマージン**、exit は **130 倍のマージン**。`tsx` のトランスパイルが支配的な CI（ubuntu-latest × Node 22/24）でも 10s を踏む余地は無い。テストファイル冒頭のコメントが書いている「Measured locally: startup 300-500ms, SIGINT to exit 5-7ms」も実測と一致していた。

  新規テストのタイミング依存も測った。`shutdown error isolation` の 1 ケース目は `shutdownTimeoutMs: 30` に対して `elapsedMs >= 25` を要求するが、10 回の実測は **30 / 31 / 32 / 32 / 32 / 33 / 33 / 33 / 33 / 33 ms**。`setTimeout` が早く発火することは無いので下振れの余地が無く、閾値 25 は妥当（マージン 5ms は「予算より短く戻ってこないこと」の判別に必要な最小限で、M16 は実測 0ms なので判別窓は 25ms ある）。

- **[N-005]** **安定性と後始末は良好。** `pnpm test`（既定順序）を **9 回**走らせて 9/9 で `Test Files 27 passed (27) / Tests 271 passed (271)`（Duration 1.22〜1.88s）。実行後に確認したもの:
  - 残留プロセス: **0 件**。`ps -eo pid,command | grep -E "src/index\.ts|vitest|__test_"` に本 worktree（`wt-test-r3`）由来のプロセスは無い（別レビュー用 worktree `wt-conc-r3` のプロセスが 1 件見えたが本テスト由来ではないので触っていない）
  - 残留ファイル: `git status --porcelain` が空。`src/__test_shutdown_fixture__` / `src/server/__test_server_fixture__` ともに `No such file or directory`
  - `pnpm typecheck` / `pnpm lint` / `pnpm format:check` すべて緑

  **順序依存も追加で調べた。** `--sequence.shuffle` を全体で 30 回近く回すと失敗が出るが、**原因はすべて本 PR の対象外ファイル**である: `src/lib/markdown.test.ts > initMarkdown guard`（単独ファイル shuffle 8 回で 4 回再現）と `src/lib/styles.test.ts > resolveStyles` の 3 ケース。どちらも `gh pr diff 116 --name-only` に含まれない既存のグローバル状態依存で、既定順序（CI の実行形態）では常に緑。**本 PR が触った 2 ファイルは順序独立**で、`src/server/index.test.ts` を shuffle 10 回・`src/server/routes/sse.test.ts` を shuffle 10 回、いずれも 10/10 で全 pass だった。

- **[N-006]** **`vi.doMock` の影響が他ファイルに漏れないことを再確認した。** `vitest.config.ts` は `pool` 未指定 = 既定（vitest 4.1.10 は `forks` / `isolate: true`）。2 つのダミーテストファイルを同時実行して `process.pid` を記録すると `49154` / `49155` と**別プロセス**。加えて `@hono/node-server` を import するのは `src/server/index.ts` だけ（`grep -rn` で確認）で、`src/server/index.test.ts` の `./routes/sse.js` への `doMock` も `finally` の `doUnmock` × 2 + `resetModules` で戻している。`import type { SseManager }` は type-only import なので消去され、静的束縛が汚染されることも無い。`withStubbedServer` を使う 2 つの `describe` はファイル末尾にあり、先行する実ポートのライフサイクル群には影響しない（`--sequence.shuffle` 10 回でも壊れないことは N-005 で確認済み）。

- **[N-007]** **AC カバレッジに欠落は無い。** AC-1〜AC-9（自動テストで担保するとされたもの）はすべてテストが存在し、**すべて今ラウンドの変異で判別性を実測した**（N-003）。2 ラウンドの変更でカバーされなくなった AC は無い。AC-3 の旧 API 記述（`shutdown({ timeoutMs: 0 })`）は plan 側で `startServer(config, { shutdownTimeoutMs })` に修正済みで、実装・テストとも整合している。AC-10 は Phase 4 の手動確認（triage で wont-fix 済み）。

- **[N-008]** **可読性。`withStubbedServer` は「なぜこう書くのか」が読み取れる。** docstring が「Steps 1-4 are all synchronous and step 4 destroys the very sockets an observer would be watching, so neither their order nor their individual failure handling is visible through a real socket. Stubbing is what makes them observable and injectable at all.」と、スタブが**必要**である理由（好みではなく観測可能性の問題であること）を明示している。`ShutdownStubs.onClose` の doc も「Not invoking the callback leaves `closing` pending forever, so only the bounded wait of step 5 can end the shutdown」と、スタブの各挙動が何を作り出すためのものかを説明している。`describe("shutdown error isolation")` の docstring も「Dropping the isolation … makes the first case below reject in ~1ms with `closeAllConnections` never recorded and no warning」と**壊れたときに何が観測されるか**まで書いてあり、実測（M1 / M16）と一致していた。テスト本体のインラインコメント（`// The step after the failing one ran...` → `// ...the bounded wait ran and expired...` → `// ...and the lone failure is reported unwrapped.`）も、3 つのアサーション群がそれぞれ何を主張しているかを 1 行で示していて読みやすい。R1 / R2 と同水準の品質が維持されている。**唯一の不一致が W-001 の「recording each shutdown step」**。

- **[N-009]** **R2 の N-001（`Server stopped` 文字列への結合）は解消**。`src/index.ts:185-188` に「`src/index.shutdown-process.test.ts` asserts on "Server stopped": it is the only externally visible evidence that `shutdown()` settled (exit code 0 alone does not prove it). Keep that substring if the wording changes.」が入り、逆方向のヒントが用意された。テスト側（`:172-182`）にも「a permanently hung `shutdown()` gives exit 0 / 6ms and no "Server stopped"」という実測値が残っていて、双方向に辿れる。

---

## 最終確認

```
（隔離 worktree: /private/tmp/.../scratchpad/wt-test-r3、5a44ecd detached）

$ git status --porcelain
(出力なし = clean)

$ pnpm test   # 既定順序で 9 回
Test Files  27 passed (27)
     Tests  271 passed (271)     ← 9/9 で同一

$ pnpm typecheck && pnpm lint && pnpm format:check
（エラーなし / Checked 109 files. No fixes applied.）

$ ps -eo pid,command | grep -E "src/index\.ts|vitest|__test_" | grep -v grep
（wt-test-r3 由来のプロセスは 0 件）

$ ls -d src/__test_shutdown_fixture__ src/server/__test_server_fixture__
No such file or directory  （両方とも残っていない）
```

検証用の変異 17 件はすべて `git checkout -- src/` で復元済み。使い捨てのプローブテスト（`src/__probe_a.test.ts` / `src/__probe_b.test.ts`）と一時的な計測用の書き換えも削除済みで、worktree は clean な状態で `git worktree remove` した。孤児化の対照実験で残った子プロセス（pid 41630）も `kill -9` 済み。メインの作業ツリーは本ファイル以外一切変更していない。
