# Requirements & Regression Review #003

**Date:** 2026-07-25
**Round:** 3回目

---

## Summary

- Blockers: 0
- Warnings: 1
- Verdict: **APPROVED**

2 ラウンド目の指摘 3 件（W-101 / W-102 / W-103）はすべて解消。PR 本文・`plan.md`・`testing.md` の 3 文書が実装と、そして互いに整合していることを 1 件ずつ突き合わせて確認した。

今回追加された実装変更（手順ごとのエラー分離 + `AggregateError` / `clients.add` の `!closed` ガード）を**ゼロベースで**再検証し、要件（Ctrl+C 1 回で必ず有限時間に終了）は新実装でも満たされていることを実機で確認した。**レビュー観点として指定された `AggregateError` の throw 経路は、実際に 2 件・3 件の失敗を注入して `process.exit(0)` に到達することを 5 回実測している。**

新規に検出した問題は `testing.md` 項目 4 の観測時間だけ（→ W-001）。実装に起因する欠陥は 0 件。

### 検証環境

- Node v22.22.1（一部 v24.18.0）/ macOS (Darwin 25.4.0) / pnpm 10.34.5
- 隔離 worktree `scratchpad/wt-req-r3`（detached HEAD = `5a44ecd`）で `pnpm install --frozen-lockfile` → `pnpm build`
- 実装を壊す検証（throw 注入 / ミューテーション）はすべて worktree 側で実施し、毎回 `git status --porcelain` が空であることを確認して復元済み
- ベースライン計測用に `scratchpad/wt-base`（merge-base `46cc093`）を一時作成し、計測後に削除
- メインの作業ツリーは本ファイル以外に一切触れていない

---

## 2ラウンド目指摘の解消状況

- **[W-101] 解消** — PR 本文が現在の実装（`5a44ecd`）に追随済み。指摘した「事実と異なる記述 6 件」「記述漏れ 3 件」をすべて突き合わせた。

  | # | 2 ラウンド目の指摘 | 現在の PR 本文 | 判定 |
  |---|---|---|---|
  | 1 | `shutdown({ timeoutMs })` は存在しない | 「シャットダウン予算は `startServer(config, { shutdownTimeoutMs })` で注入可能にし…memo 化されるため予算を `shutdown()` の引数にすると契約の矛盾が生じる」 | **解消**（`src/server/index.ts:43-49, 155` と一致） |
  | 2 | `isHttpServer` 型述語は実装されていない | 「採用しなかったもの」に「`in` ナローイングの型述語（`isHttpServer`）化 — レビューで撤回」として移動 | **解消**（`grep -rn isHttpServer src/` = 0 件と一致） |
  | 3 | `watcher` の削除が書かれていない | 「`ServerInstance` から未使用の `close` / `sseCloseAll` / `watcher` を削除し、`{ shutdown }` の 1 メソッド型に」 | **解消**（`src/server/index.ts:51-62` と一致） |
  | 4 | `close()` の順序の表現が曖昧 | 「`server.close()` をシャットダウンの**手順 1**（`sse.shutdown()` / `closeAllConnections()` より前）に置き…Issue 本文の修正案 1 と一致」 | **解消** |
  | 5 | テスト件数 266 / +15 が誤り | 「27 files / 271 tests all pass（merge-base は 25 files / 251 tests なので +2 files / +20 tests）」 | **解消・実測一致**（下記） |
  | 6 | 判別性テーブルの 2 行が旧内容 | 「`shutdown()` を無限ハングさせると FAIL（`Server stopped` の出力が無い）／`closeAllConnections()` 無効化で FAIL」「`{ shutdownTimeoutMs: 0 }` で warn 1 回 / 既定で 0 回」に差し替え、層も `src/server/index.test.ts` と明示 | **解消・実測一致**（下記） |
  | 7 | 手順のエラー分離が未記載 | 「手順 2〜4 を個別に捕捉し…失敗が 1 件ならそのまま throw、2 件以上なら `AggregateError` にまとめて」 | **解消**（今回の実装変更も含めて反映） |
  | 8 | 再入ガードの `Promise.withResolvers` 化が未記載 | 「再入ガードを `Promise.withResolvers()` による deferred の先行代入に変更」 | **解消** |
  | 9 | `onAbort` の登録順序が未記載 | 「`stream.onAbort(cleanup)` を `clients.add(client)` より前に登録し、`clients.add` を `if (!closed)` でガード…2 つで 1 組」 | **解消**（今回追加の `!closed` ガードも反映済み） |

  加えて、2 ラウンド目に「追加が望ましい」とした判別性テーブルの行（`clearTimeout` 回帰ガード / `shutdown step order`）も両方追加されている。**PR 本文に、実装と食い違う記述はもはや 1 件も見つからなかった。**

- **[W-102] 解消** — `.issue/102/testing.md` の 2 箇所。
  - 「リスニングハンドルは**手順 1**（シャットダウンの最初の操作 = `server.close()`）の時点で閉じている」に修正済み（`src/server/index.ts:227` と一致）。
  - ビルドサイズは数値ごと削除され「**生成サイズは変更のたびに動くので確認項目にしない。**」に置換。実測 131 kB で数値を追いかけない方針は妥当。

- **[W-103] 解消** — `.issue/102/plan.md` が実装に追随済み。
  - AC-3 の本文が `startServer(config, { shutdownTimeoutMs: 0 })` に更新（`:25`）。
  - `isHttpServer` は「実装レビューで撤回した」として 4 箇所すべて反転（`:60, :320, :553, :579`）。
  - `watcher` は「当初『残す』判断だったが、実装レビューで削除に反転した」に更新（`:61, :316, :552, :580`）。
  - 手順順序は `close()` = 手順 1 に統一（`:330, :342, :366`）。エラー分離（`:343-344`）・再入ガード（`:352-364`）・ADR-008 / ADR-009（`:583-584`）も追記済み。
  - `grep` で確認した残存は `:682` の 1 箇所のみ（「手順 2 でリスニングハンドルを閉じている」）だが、これは**「レビュー履歴 / 計画レビュー 3 周目」節の当時の記録**であり、当時の設計を正しく記述している。履歴の書き換えは不要と判断する（→ N-004）。
  - `adr.md` 側も「旧手順番号の残存 4 箇所」が解消され、ADR-002 が `close()` = 手順 1 + 手順ごとの捕捉 + `AggregateError` に改訂されている。

---

### Requirements & Regression

#### 受け入れ基準の検証

| AC | 内容 | 判定 | 根拠 |
|---|---|---|---|
| AC-1 | SSE 接続中に SIGINT 1 回で 5 秒以内・exit code 0 | **満たす** | `src/index.shutdown-process.test.ts` pass。`dist/index.mjs` 実測: ディレクトリ + SSE 3 本 exit 0 / 39〜57ms、HTML ファイルモード exit 0 / 37ms、SSE 3 本 × 97 秒放置 exit 0 / 57ms、Node 24.18.0 exit 0 / 64ms、実 TTY の `^C` で `GOTSTATUS=0`。**`AggregateError` throw 経路でも 5/5 とも exit 0**（下記） |
| AC-2 | `server.close()` が永久に解決しなくても有限時間で settle | **満たす**（間接検証 + 実機 end-to-end） | `src/lib/with-timeout.test.ts` が永久保留 Promise を注入。`shutdown()` の唯一の待機点が `withTimeout(closing, shutdownTimeoutMs)`（`src/server/index.ts:245`）であることをコードで確認。**実機**: 手順 2〜4 を全部 throw させ SSE ソケットを生かしたまま SIGINT → 2/2 とも exit 0 / 2066ms・2044ms + 警告 1 件 |
| AC-3 | 予算 0 で決定的にタイムアウト分岐 + `logger.warn` / 既定値で偽陽性なし | **満たす**（AC 文言も更新済み） | `warns when the server does not close within the budget` / `does not warn on a healthy shutdown with an open SSE connection` が pass。実機でも正常系 20 試行以上すべて `did not close within` = 0 件。AC-3 の文言が `startServer(config, { shutdownTimeoutMs: 0 })` に更新され、存在する API を指すようになった |
| AC-4 | `shutdown()` から戻った直後（最初の await 前）にリスナーが閉じている | **満たす** | `closes the listener before destroying live connections, both before yielding`（`src/server/index.test.ts:264`）が `serve()` スタブで同期的に検証。`const closing = close()` は `try` の外・手順 1（`src/server/index.ts:227`）で、手順 1〜4 に `await` は無い。実機でも `--port` 衝突テスト（下記）で 1 つ目の終了直後に同ポート再 bind が 3/3 成功 |
| AC-5 | シャットダウン後の `/sse` は 503、ストリームを開始しない | **満たす** | `GET /sse after shutdown responds 503 without starting a stream` が pass。`src/server/routes/sse.ts:50-53` の早期 return |
| AC-6 | シャットダウン後に `/sse` を叩いても `clientCount` が 0 のまま | **満たす** | `GET /sse after shutdown does not register a client` / `shutdown resets clientCount to zero and refuses further clients` が pass |
| AC-7 | 接続済み SSE の body が keep-alive を待たず EOF に達する | **満たす** | `shutdown ends connected streams without waiting for the keep-alive interval` が pass。`!closed` ガードの追加は per-client abort の経路（`cleanup()` → `abortController.abort()`）に触れていない |
| AC-8 | client 1 本あたりの abort リスナーが keep-alive 周回で増えない + positive control | **満たす** | `does not accumulate abort listeners per client` が pass。`if (!reader) throw` による退化防止（`sse.test.ts:175`）も維持 |
| AC-9 | 既存のシャットダウン関連テストが引き続き通る | **満たす** | `pnpm test`: **27 files / 271 tests all pass**。merge-base `46cc093` を隔離 worktree で実測した基準値は **25 files / 251 tests**。`pnpm typecheck`（エラーなし）/ `pnpm lint`（109 files, no fixes）/ `pnpm format:check`（109 files, no fixes）もすべて green |
| AC-10 | 手動確認（ブラウザタブ常時オープン × Ctrl+C 10 回、所要時間・警告有無の記録） | **未実施**（Phase 4 の作業項目） | `triage.md` で `plan.md:AC-10/手動確認未実施` = wont-fix（Phase 4 の作業項目）と仕分け済み。本レビューでも実ブラウザの `EventSource` / 10 分以上の放置 / 実端末での 10 回試行は未カバー。ただし **SSE 3 本 × 97 秒（keep-alive 3 周）× 実 SIGINT** と **実 TTY の `^C`** と **Node 24.18.0** は本レビューでカバーした |

**総括: AC-1〜AC-9 は満たす。AC-10 のみ Phase 4 の作業項目として未実施（実装起因の欠陥ではない）。** 2 ラウンド目にあった「AC-3 の文言が旧 API」の不整合も解消された。

#### Issue の唯一の要件に対するコードパスの再追跡（今回の実装での全経路）

```
src/index.ts:172 shutdown(signal)
  ├─ shuttingDown 二重押しガード → process.exit(1)               [有界・実測 exit 1]
  ├─ console.log() / logger.info(`Received ${signal}`) / intro()  [同期]
  ├─ await server.shutdown()                                      ← 唯一の await
  │    src/server/index.ts:272 shutdown()
  │      ├─ Promise.withResolvers() で memo を「先に」公開        [同期]
  │      └─ runShutdown()
  │           1. const closing = close()          同期・try の外・memo 化
  │           2. step(() => sse.shutdown())       個別捕捉 → failures
  │           3. step(() => watcher.close())      個別捕捉 → failures
  │           4. step(() => closeAllConnections()) 個別捕捉 → failures
  │           5. try { await withTimeout(closing, 2000) } catch { failures.push }
  │              timed-out なら logger.warn                        ← 唯一の待機点
  │           6. failures.length === 1 → throw failures[0]
  │              failures.length  >  1 → throw AggregateError
  ├─ catch → logger.error("Failed to shut down server:", e)       [reject / AggregateError でも到達]
  ├─ outro("Server stopped. Bye!")
  └─ process.exit(0)
```

**無界の待機点は存在しない。** 手順 2〜4 のどれが失敗しても手順 4 と手順 5 に到達する（`step()` が個別に捕捉するため）。指定された観点である **`AggregateError` の throw 経路**を、`dist/index.mjs` にフォールト注入して実機で検証した（`--host 127.0.0.1 --no-open`、SSE 接続 1 本あり）:

| 注入 | 失敗件数 | 試行 | exit | elapsed | タイムアウト警告 | `Server stopped` |
|---|---|---|---|---|---|---|
| 手順 2・3 を throw（手順 4 は実行される） | 2 → `AggregateError` | 3 | **0** | 39 / 39 / 41ms | なし | あり |
| 手順 2・3・4 を throw（`closeAllConnections()` が飛ぶ） | 3 → `AggregateError` | 2 | **0** | 2066 / 2044ms | **あり** | あり |

出力の実物（前者・1 試行目）:

```
[peek] Received SIGINT, shutting down...
┌   Shutting down...
[peek] Failed to shut down server: AggregateError: Failed to shut down the server.
    at runShutdown (...:1441:34)
    ... {
  [errors]: [
    Error: INJECTED sse
        at step (...:1424:5) ...,
    Error: INJECTED watcher
        at step (...:1424:5) ...
  ]
}
│
└  Server stopped. Bye!
```

**`AggregateError` は CLI の `catch` に落ちて `logger.error` に渡り、`outro()` → `process.exit(0)` に到達する。`errors` 配列に個々の失敗が両方載っており、PR 本文の「どの失敗も無言で消えない」という主張は実機で成立している。** 後者（3 件失敗）では手順 4 が飛ぶため有界待機が予算をフル消費するが、それでも 2.0 秒で警告を出して exit 0 に到達しており、AC-1（5 秒以内）を満たす。

その他の経路も再確認した:

- `closing` が予算内に reject した場合 → 手順 5 の `catch` が `failures` に**追加**する（2 ラウンド目の N-101 で指摘した「手順 2〜4 の failure が上書きされて消える」経路は、失敗チャネルの配列化で構造的に解消された）。
- 予算切れ後に `closing` が reject した場合 → `withTimeout` が `then(_, reject)` を張ったままなので unhandled rejection にならない（`src/lib/with-timeout.ts:38-49`）。
- 2 回目のシグナル → `Force exiting...` + exit 1。実機で 2/2 確認（1 回目を 2 秒かかる状態にした場合）。正常系の連打では 3/3 とも exit 0 で `Force exiting...` は出ない。

#### PR 本文と実装の突き合わせ（今回の再検証）

2 ラウンド目に指摘した 9 件はすべて解消（上記 W-101）。**加えて、PR 本文に残るすべての技術的主張をゼロベースで実装と照合し、食い違いは 0 件だった。**

| PR 本文の主張 | 照合結果 |
|---|---|
| `src/lib/with-timeout.ts` 新規 / 既定 2 秒 / `!(timeoutMs > 0)` で `NaN` も拾う / タイマーを `unref()` しない | 一致（`with-timeout.ts:32, 39`、`index.ts:67`） |
| 打ち切り時に `logger.warn` | 一致。実文言 `[peek] HTTP server did not close within 2000ms — giving up and leaving the remaining sockets to the caller.` |
| `startServer(config, { shutdownTimeoutMs })` で注入 | 一致（`index.ts:43-49, 155-156`） |
| `SseManager` のフラグ + `closeAll` → `shutdown` 終端化 + 二重チェック | 一致（`sse.ts:26, 39-45, 50-53, 85-93`） |
| `onAbort` を `clients.add` より前 + `clients.add` を `!closed` でガード | 一致（`sse.ts:80-83`） |
| `server.close()` が手順 1 | 一致（`index.ts:227`） |
| 手順 2〜4 の個別捕捉 / 1 件は throw / 2 件以上は `AggregateError` | 一致（`index.ts:222-256`）。実機で `AggregateError` を確認 |
| 再入ガードの `Promise.withResolvers()` 先行代入 | 一致（`index.ts:272-279`） |
| keep-alive を `node:timers/promises` に置換 | 一致（`sse.ts:1, 98-100`） |
| `ServerInstance` が `{ shutdown }` の 1 メソッド | 一致。`grep` で `sseCloseAll` 0 件 / `closeAll(` 0 件 |
| SIGINT/SIGTERM の受信ログ | 一致。実機で `Received SIGINT` / `Received SIGTERM` を確認 |
| 不採用 4 件（`isHttpServer` / stdio drain / 再 `closeAllConnections()` / `closeIdleConnections()` 併用） | 一致。`grep -rn isHttpServer src/` = 0 件、`closeIdleConnections` は手順 4 の説明コメント 1 件のみで呼び出しなし |
| 27 files / 271 tests、merge-base 25 files / 251 tests | **実測一致**。worktree で `pnpm test` → `Test Files 27 passed (27) / Tests 271 passed (271)`。merge-base `46cc093` の隔離 worktree で `Test Files 25 / Tests 251` |
| `pnpm dev` を使わない理由（`dev:css` を `&` で並行 + `trap`） | 一致（`package.json: "dev": "pnpm dev:css & trap 'kill %1 2>/dev/null' EXIT; pnpm dev:server"`） |

判別性テーブルの主張を 4 件、ミューテーションで独立に再現した:

| PR 本文の主張 | 実測 |
|---|---|
| 「`closeAllConnections()` 無効化で FAIL」 | 手順 4 の本体を削除 → `src/index.shutdown-process.test.ts` が `expect(elapsedMs).toBeLessThan(2_000)` で **1 failed** |
| 「`clearTimeout` を削除すると FAIL」 | `clearTimeout(timer)` を 2 箇所削除 → `leaves no pending timer behind when the promise settles inside the budget` のみ **1 failed / 7 passed** |
| 「try/catch 撤去で 3 ケース FAIL」 | `step()` を `run()` だけに → `src/server/index.test.ts` が **3 failed / 9 passed** |
| 「`AggregateError` 分岐を壊すと FAIL」 | `throw new AggregateError(...)` を `throw failures[0]` に → **2 failed / 10 passed** |

#### `.issue/102/testing.md` の Phase 4 実行可能性

記載のコマンドを（ブラウザ操作を除き）実際に実行して確認した。

| 記載箇所 | 判定 | 実測 |
|---|---|---|
| `pnpm build` → `node dist/index.mjs . --host ... --port ...` | **実行可** | `dist/index.mjs` 131 kB が生成され、起動 → `GET /` 200 → SIGINT → `Server stopped. Bye!` → exit 0 |
| 代替の `node --import ./src/loaders/css.mjs --import tsx/esm src/index.ts ...` | **実行可** | `GET /` 200、SIGINT で exit 0 |
| 「生成サイズは確認項目にしない」（W-102 の修正） | **妥当** | 実測 131 kB。数値を書かない方針で追随不要になった |
| HTML モードの対象 `testdata/html/01-basic-structure.html` | **実在** | 同ファイルで SSE / ライブリロード / SIGINT 終了を実測 |
| ブラウザ自動化用の計測レシピ（`kill -INT` + `wait` + `node -e` でタイムスタンプ） | **実行可** | 同形の手順で `exit=0 elapsed=37〜64ms`。記載の実測例「`exit=0 elapsed=42ms`」と整合 |
| 警告の検索キー `did not close within` | **一致** | 実出力と一致。`logger.warn` = stderr なのでレシピの `2>&1` が必要 — 記載どおり付いている |
| 項目 1「`^C` と `Received SIGINT` が同じ行に連結しない / 枠が崩れない」 | **一致** | 実 TTY（expect + pty）で `^C` → 空行 → `[peek] Received SIGINT, ...` → `┌ Shutting down...` → `│` → `└ Server stopped. Bye!`、`GOTSTATUS=0` |
| 項目 1「警告が出た試行では枠内に警告行が 1 行割り込むのが正常」 | **一致** | 3 件失敗の注入で `┌` → 警告 → `Failed to shut down server: AggregateError` → `│` → `└` を再現 |
| **項目 4「再接続は最大 10 回で停止」を「2 分間観察する」** | **食い違い** | バックオフの合計時間から 10 回目は **約 181 秒（≈3 分）** 後。2 分では 8 回目までしか観測できない → **W-001** |
| 項目 4「30 秒待たずに切断検知」「503 は見えなくて正常」 | **一致** | per-client abort（AC-7）と手順 1 の `close()` から論理的に成立。SSE body の即 EOF は自動テストで確認済み |
| 項目 6 の `nix shell nixpkgs#nodejs_24 -c node --version` | **実行可** | `v24.18.0`（記載どおり）。同 Node で `dist/index.mjs` の起動 → SIGINT → exit 0 / 64ms / 警告なし |
| エッジケース 1（2 回連打で通常は `Force exiting...` が出ず exit 0） | **一致** | 3/3 とも exit 0・未出力。遅いシャットダウンを作れば 2/2 で exit 1 + 出力 |
| エッジケース 2（`tee` 経由で出力が欠落しない / peek が EPIPE で落ちない） | **一致** | `tee` 経由のログに `Server stopped. Bye!` が 1 件、peek は SIGINT 後に確実に消滅 |
| エッジケース 3（SIGTERM で exit 0 / `Received SIGTERM`） | **一致** | exit 0 / 37ms、`[peek] Received SIGTERM, shutting down...` |
| エッジケース 4（SSE なしのベースライン） | **一致** | exit 0 / 数十 ms、警告なし |
| 「連続起動でのポート再利用」 | **一致** | 同一ポートで 3 連続起動 → 3/3 とも `Server started` / `already in use` 0 件 |
| 「`--port` 衝突時の起動失敗」 | **一致** | 2 つ目が `Port 54331 is already in use` → exit 1 / 161ms、1 つ目は無傷（`GET /` 200） |

**判定: 項目 4 の観測時間（W-001）を除き、`testing.md` は Phase 4 でそのまま実行できる。** W-001 も期待結果の読み替え（または観測時間の延長）だけで済み、検証をブロックしない。

#### 既存機能への回帰（すべて実機で確認）

worktree の `pnpm build` 成果物（`dist/index.mjs`）を `--host 127.0.0.1 --no-open` で起動して実施。

**1. ライブリロード / 複数クライアント同時接続（ディレクトリモード）— 回帰なし**

`curl -N` で **3 本の SSE を同時接続**した状態で、Markdown の編集 → ファイルの追加 → ファイルの削除を行った。**3 クライアントすべてが 6 イベント（`file-changed` × 3 と `tree-changed` × 3）を欠落なく受信**した:

```
=== client 1 / 2 / 3（いずれも同一） ===
event: file-changed
data: {"path":"README.md"}      ← Markdown を編集

event: tree-changed
data: {}

event: file-changed
data: {"path":"added.md"}       ← ファイル追加

event: tree-changed
data: {}

event: file-changed
data: {"path":"added.md"}       ← ファイル削除

event: tree-changed
data: {}
```

`GET /api/tree` も正常。**今回追加された `clients.add` の `!closed` ガードは、通常時の SSE 登録・ブロードキャストを一切阻害していない。** コードを読んでも、`closed` は `cleanup()` でしか true にならず、`cleanup` は `stream.onAbort` 経由でしか到達しない。Hono の `streamSSE` はハンドラを同期的に `run()` してから `c.newResponse()` を返す（`node_modules/hono/dist/helper/streaming/sse.js`）ので、`onAbort(cleanup)` 登録から `if (!closed)` までの間に abort が挟まる余地は現行の Hono では無く、**ガードは今日は必ず通過する** — 将来 `await` が入った場合の保険という PR 本文の説明と一致する。

**2. ライブリロード（HTML ファイルモード）— 回帰なし**

`node dist/index.mjs <path>.html` で起動。トップレベル HTML に `new EventSource` のインラインスクリプトが 1 件。**2 本同時接続**でファイル編集 → 両方に `event: file-changed / data: {}` が到達。SIGINT → exit 0 / 37ms / 警告 0 件。

**3. 長時間 keep-alive（60 秒以上）— 回帰なし**

`KEEP_ALIVE_INTERVAL_MS = 30_000` に対し、**3 本の SSE を 97 秒維持**して keep-alive を **3 周**させてから SIGINT を送った:

```
uptime: 01:37
client 1 keepalive=3
client 2 keepalive=3
client 3 keepalive=3
GET / -> 200
LONG-KEEPALIVE SIGINT exit=0 elapsed=57ms
warn count: 0
[peek] Received SIGINT, shutting down...
┌   Shutting down...
│
└  Server stopped. Bye!
```

**`!closed` ガードと `node:timers/promises` への置換の複合影響は観測されなかった。** keep-alive が 3 周した後でも接続は生きており（`: keep-alive` が client あたり 3 行）、SIGINT から 57ms で exit 0、タイムアウト警告は 0 件。別途 95 秒放置した同条件の試行でも同じ出力になった（そちらは `wait` の親シェル違いで exit code を採れなかったため再実行した）。

**4. `--port` 衝突時の起動失敗 — 回帰なし**

```
◇  Failed to start server
└  Port 54331 is already in use
second peek exit=1 elapsed=161ms
```

1 つ目のプロセスは無傷（`GET /` = 200）で、その後 SIGTERM で exit 0。listen エラー経路（`src/server/index.ts:195-200`）は `sse.shutdown()` + `watcher.close()` のみを呼び、`closePromise` はまだ宣言されていないため memo 化と競合しない構造は変わっていない。

**5. SIGTERM 経路 — 回帰なし**

exit 0 / 37ms、`[peek] Received SIGTERM, shutting down...`。SIGINT とシグナル名で判別できる。

**6. 2 回目のシグナルによる force exit — 分岐は健在、正常系では到達しない（設計どおり）**

- 正常系の連打（`kill -INT` × 2 を即時）: 3/3 とも exit 0・`Force exiting...` 未出力。
- 1 回目を 2 秒かかる状態（手順 2〜4 を throw で飛ばす）にして 300ms 後に 2 回目: 2/2 とも **exit 1** + `Force exiting...` 1 件。

`testing.md` エッジケース 1 の記述と完全に一致する。

**7. CLI の出力（実 TTY）— 回帰なし**

expect + pty で実 `^C` を送った出力（エスケープを可読化）:

```
└  Press Ctrl+C to stop

^C
[peek] Received SIGINT, shutting down...
┌   Shutting down...
│
└  Server stopped. Bye!

GOTSTATUS=0
```

`^C` のエコーと `[peek] Received SIGINT, ...` は `console.log()` の空行で分離され、同じ行に連結していない。clack の枠も崩れていない。

**8. Node 24（報告者環境系）— 回帰なし**

`nix shell nixpkgs#nodejs_24`（v24.18.0）で `dist/index.mjs` を起動 → `GET /` 200 → SSE 接続 → SIGINT → **exit 0 / 64ms / 警告 0 件**。

**9. 品質ゲート**

`pnpm typecheck`（エラーなし）/ `pnpm lint`（109 files, no fixes）/ `pnpm format:check`（109 files, no fixes）/ `pnpm test`（27 files / 271 tests pass）すべて green。ミューテーション実行後も `git status --porcelain` は空。

#### Blockers

なし

#### Warnings

- **[W-001]** `.issue/102/testing.md` 項目 4 の「2 分間観察する」では、期待結果「最大 10 回で停止して無限には続かない」を確認できない
  - 場所: `.issue/102/testing.md` 「4. シャットダウン後のブラウザ側の再接続挙動（DevTools Network）」手順 4 と期待結果
  - 理由: 2 つのクライアント実装（`src/client/lib/sse.ts` と `src/server/renderer/html-document.tsx` のインラインスクリプト）はどちらも `delay = min(SSE_INITIAL_RETRY_MS * 2^(n-1), SSE_MAX_RETRY_MS)` = `min(1000 * 2^(n-1), 30000)`、上限 `SSE_MAX_RETRIES = 10`（`src/core/sse-constants.ts`）。試行のタイムラインは 1s → 3s → 7s → 15s → 31s → 61s → 91s → 121s → 151s → **181s** で、諦めるのは 10 回目の失敗後（約 3 分）。**手順どおり 2 分観察すると 8 回目までしか見えず、「まだ再接続し続けている」状態で観察が終わる。** Phase 4 の実施者が期待結果を文字どおり照合すると、正常な挙動を FAIL と記録しうる。
  - なお `src/client/lib/sse.ts` の `stableTimer`（`SSE_STABLE_THRESHOLD_MS = 5000` で `retryCount` を 0 に戻す）は、接続が 5 秒以上維持された場合のみ発火する。シャットダウン後は `ERR_CONNECTION_REFUSED` が即座に返るため `onerror` が先に `clearTimeout` してリセットは起きない（＝上記タイムラインは短縮されない）。
  - 提案: 観察時間を「**4 分**」にするか、期待結果を「2 分の観察では試行間隔が 1s → 2s → 4s → 8s → 16s → 30s と指数的に伸びて 30 秒上限に張り付くことを確認する。停止（10 回上限）は約 3 分後なので、そこまで見る場合は観察を 4 分に延ばす」と書き分ける。**この 1 点だけで、`testing.md` は Phase 4 でそのまま実行できる。**

#### Notes

- **[N-001]** 2 ラウンド目の N-101（「`closing` が予算内に reject すると手順 2〜4 の failure が握りつぶされる」）は、失敗チャネルの配列化（`failures: unknown[]` + 手順 5 の `catch` で push）によって構造的に解消された。両方が起きた場合は `AggregateError.errors` に 2 件とも載る。実機で `errors` 配列に個々の `Error` が入ることを確認済み。

- **[N-002]** `logger.warn` / `logger.error` は `console.warn` / `console.error` = **stderr**。`testing.md` の計測レシピはすべて `2>&1` を付けており取りこぼさない。`AggregateError` は `console.error` の既定フォーマットで `[errors]` 配列を展開して出すため、Phase 4 で万一この経路を踏んだ場合も原因が読める（実機で確認）。

- **[N-003]** `Promise.withResolvers` / `AggregateError` はいずれも Node 22.0.0 以降 / ES2024。`package.json` の `engines.node` は `>=22.0.0`、`tsconfig` の `target` / `lib` は `ES2024` で整合。Node 22.22.1 と 24.18.0 の両方で実 CLI の動作を確認した。

- **[N-004]** `.issue/102/plan.md:682`（計画レビュー 3 周目の記録）に「手順 2 でリスニングハンドルを閉じている」が残っているが、これは**当時の設計を記述した履歴**であり、現在の設計を述べている箇所（`:330, :342, :366`）はすべて「手順 1」に更新済み。履歴の書き換えは不要と判断する。`adr.md` 側の現行記述（ADR-002 / ADR-007）も「手順 1」で統一されている。

- **[N-005]** Phase 4 の所要時間の目安: 項目 1（10 回 × 1〜2 分放置）で約 20〜30 分、項目 3（10 分放置）で約 12 分、項目 6（3 回 × 数分）で約 10 分、W-001 を反映すると項目 4 が 4 分。合計で **1 時間前後**を見込むこと。項目 1 の 10 試行は「所要時間」と「警告の有無」を毎回記録する必要がある（AC-10 の本質は再現確率の証明ではなく観測記録である旨が `plan.md` に明記されている）。

- **[N-006]** 実機計測サマリ（worktree の `dist/index.mjs`、特記なき限り Node v22.22.1 / macOS）

  | 条件 | 試行 | exit | wall（`node -e` 約 30ms 込み） | 警告 |
  |---|---|---|---|---|
  | ディレクトリ + SSE 3 本 + SIGINT | 1 | 0 | 39ms | なし |
  | ディレクトリ + SSE 3 本 × **97 秒放置**（keep-alive 3 周）+ SIGINT | 1 | 0 | 57ms | なし |
  | HTML ファイルモード + SSE 2 本 + SIGINT | 1 | 0 | 37ms | なし |
  | ディレクトリ + SSE 1 本 + SIGTERM | 1 | 0 | 37ms | なし |
  | 実 TTY で `^C`（expect + pty） | 1 | 0 | 即時 | なし |
  | **Node v24.18.0** + SSE 1 本 + SIGINT | 1 | 0 | 64ms | なし |
  | 手順 2・3 を throw（`AggregateError` 2 件） | 3 | **0** | 39〜41ms | なし |
  | 手順 2・3・4 を throw（`AggregateError` 3 件・有界待機経路） | 2 | **0** | 2066 / 2044ms | **あり** |
  | 同上 + SIGINT 2 回（force exit 経路） | 2 | **1** | — | なし |
  | SIGINT 2 回・正常系 | 3 | 0 | — | なし |
  | `--port` 衝突（2 つ目の起動） | 1 | 1 | 161ms | — |
  | 同一ポートでの連続起動（正常終了直後の再 bind） | 3 | 0 | — | なし |
  | `tee` 経由（パイプ）+ SIGINT | 1 | — | — | なし（`Server stopped` はログに残る） |
  | tsx 直接起動（testing.md の代替手順） | 1 | 0 | — | なし |

  **正常系で警告が一度も出ないこと（AC-3 の偽陽性なし）と、手順が壊れても 2 秒で打ち切って exit 0 になること（AC-1 / AC-2）の両方を、今回の実装で再確認できている。**

- **[N-007]** 本レビューの破壊的検証はすべて隔離 worktree（`scratchpad/wt-req-r3`、detached HEAD `5a44ecd`）とその `dist/` のコピーに対して行い、各ミューテーションの直後に `git status --porcelain` が空であることを確認して復元した。ベースライン計測用の `scratchpad/wt-base`（`46cc093`）も計測後に削除済み。レビュー終了時点で両 worktree とも削除済みで、メインの作業ツリーには本ファイル以外の変更を加えていない。
