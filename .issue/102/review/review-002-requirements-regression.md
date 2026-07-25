# Requirements & Regression Review #002

**Date:** 2026-07-25
**Round:** 2回目

---

## Summary

- Blockers: 0
- Warnings: 3
- Verdict: **APPROVED**

1 ラウンド目の指摘は 4 件中 2 件（W-002 / W-003、いずれも `testing.md` の期待結果）が解消。残る 2 件は台帳どおり「Phase 4 の作業項目」（W-001）と「wont-fix」（W-004）で、実装起因の欠陥ではない。

大きく変わった実装（`close()` が手順 1 / 手順 2〜4 のエラー分離と rethrow / `Promise.withResolvers` 再入ガード / `startServer` へのタイムアウト注入 / `ServerInstance` の縮小 / `in` ナローイングへの回帰）を**ゼロベースで再検証**し、Issue の唯一の要件は新実装でも満たされていることを実機で確認した。**特にレビュー観点として指定された「エラー分離の rethrow 経路」は、実際に throw を注入して `process.exit(0)` に到達することを 5 回実測している。**

一方、**PR 本文は 1 ラウンド目の修正を一切反映しておらず、現在の実装と食い違う記述が 6 箇所・不足が 3 箇所ある**（W-101）。Phase 4 で必ず更新すること。

### 検証環境

- Node v22.22.1 / macOS (Darwin 25.4.0) / pnpm 10.34.5
- 隔離 worktree `scratchpad/wt-req-r2`（`origin/issue/102/fix-shutdown-hang` = `b8e5da3`）で `pnpm install --frozen-lockfile` → `pnpm build` し、**`dist/index.mjs` を 40 回以上起動**して検証
- 実装を壊す検証（throw 注入 / hang 注入）はすべて worktree 側で実施し、毎回 `git diff --stat` が空であることを確認して復元済み
- メインの作業ツリーは本ファイル以外に一切触れていない

---

## 1ラウンド目指摘の解消状況

- **[W-001] 未解消（想定内）** — AC-10（ブラウザタブ常時オープン × Ctrl+C 10 回、所要時間・警告有無の記録）は依然未実施。`triage.md` で `plan.md:AC-10/手動確認未実施` = wont-fix（Phase 4 の作業項目）と仕分けられており、実装起因の欠陥ではない。本レビューでもヘッドレス相当（実 SSE ソケット・実 SIGINT・実 TTY の `^C`・複数接続・HTML モード）は網羅したが、**実ブラウザの `EventSource` / 10 分以上の放置 / Node 24 × macOS は依然未カバー**。

- **[W-002] 解消** — `.issue/102/testing.md:101-108` に「タイムアウト警告が出た試行では枠の内側に警告行が 1 行割り込むのが正常」という補記と実例ブロックが追加された。**追記された実例が現実に即しているかを実機で確認した**（手順 2〜4 を throw で丸ごと飛ばして SSE を張ったまま SIGINT）:

  ```
  [peek] Received SIGINT, shutting down...
  ┌   Shutting down...
  [peek] HTTP server did not close within 2000ms — giving up and leaving the remaining sockets to the caller.
  [peek] Failed to shut down server: Error: INJECTED early failure
  │
  └  Server stopped. Bye!
  ```

  `testing.md` の記載（`┌` の直後に警告 1 行 → `│` → `└`）と実出力が一致。文言 `HTTP server did not close within 2000ms — ...` も検索キー `did not close within` と一致する。

- **[W-003] 解消** — `.issue/102/testing.md:186-194` のエッジケース 1 が「通常は `Force exiting...` は表示されず exit code は 0」「exit code は 0 でも 1 でもよい」「判定基準はハングしないこと」に書き換えられた。**書き換え後の期待が現実に即しているかを実機で確認**: 押下間隔 0 / 5 / 20 / 50ms × 各 3 試行 = **12/12 が exit 0・`Force exiting...` 未出力・`Server stopped` 出力**。逆方向の判別性も確認済み（手順 2〜4 を throw で飛ばして 1 回目のシャットダウンを 2 秒かかる状態にすると 2/2 とも **exit 1 + `Force exiting...`**）。書き換え後の記述はどちらの分岐も正しく説明している。

- **[W-004] 未解消（wont-fix）** — `triage.md` の `src/server/shutdown-process.test.ts:dist/index.mjs未起動` = wont-fix（`pretest` が tsdown を実行しないためビルド順序に依存する、Phase 4 の手動確認で埋める）。テストは `src/index.shutdown-process.test.ts` に移動したが、起動対象は依然 `node --import tsx/esm src/index.ts` のまま。本レビューで `dist/index.mjs`（`bin.peek` の実体、130.90 kB）に対して実 SIGINT / SIGTERM / TTY `^C` を 40 回以上送りすべて期待どおりであることを手で確認したので、実害は現時点で無い。フォローアップ Issue 化の提案は維持する。

---

### Requirements & Regression

#### 受け入れ基準の検証

| AC | 内容 | 判定 | 根拠 |
|---|---|---|---|
| AC-1 | SSE 接続中に SIGINT 1 回で 5 秒以内・exit code 0 | **満たす** | `src/index.shutdown-process.test.ts` が pass、かつ**今回は判別性がある**（後述の 2 ミューテーションで確実に fail）。`dist/index.mjs` 実測: ディレクトリ + SSE 1 本 5/5・SSE 3 本 3/3・SSE 0 本 3/3・HTML ファイルモード 3/3・SIGTERM 3/3 すべて exit 0（wall 38〜66ms、うち約 30ms は計測用 `node -e` 起動コスト）、警告 0 件、`Received SIG*` と `Server stopped. Bye!` を毎回出力。実 TTY（expect + pty）で `^C` を送っても `GOTSTATUS=0`。**rethrow 経路も exit 0**（下記） |
| AC-2 | `server.close()` が永久に解決しなくても有限時間で settle | **満たす**（間接検証 + 実機 end-to-end） | `src/lib/with-timeout.test.ts` が永久保留 Promise を注入。`shutdown()` の唯一の待機点が `withTimeout(closing, shutdownTimeoutMs)`（`src/server/index.ts:245`）であることをコードで確認。**実機**: 手順 2〜4 を throw で丸ごと飛ばして SSE ソケットを生かしたまま（＝ `close()` のコールバックが永久に来ない）SIGINT を送ると 2/2 とも **exit 0 / 2090ms・2070ms、警告 1 件**。新しい手順順序でも有界性が end-to-end で成立している |
| AC-3 | 予算 0 で決定的にタイムアウト分岐 + `logger.warn` / 既定値で偽陽性なし | **満たす**（ただし **AC 文言が旧 API のまま** → W-103） | `src/server/index.test.ts:121-140` が `startServer({...}, { shutdownTimeoutMs: 0 })` + 引数なし `shutdown()` に書き換わり pass（warn 1 回 / `did not close within` を含む）。偽陽性なしは (a) プロセステストの `expect(output).not.toContain("did not close within")`、(b) 実機 17 試行すべて `warn=0` で確認。**AC-3 の本文は依然 `shutdown({ timeoutMs: 0 })` と書いており、この API はもう存在しない** |
| AC-4 | `shutdown()` から戻った直後（最初の await 前）にリスナーが閉じている | **満たす**（1 ラウンド目より強化） | `close()` が**手順 1** に移動（`src/server/index.ts:220`）。手順 1〜4 に `await` は無く、最初の `await` は L245。新設の `shutdown step order` テスト（`src/server/index.test.ts:157-203`）が `serve()` をスタブし、`await` 前に `calls` を読んで `["close", "closeAllConnections"]` を同期的に検証する（1 ラウンド目の「0〜10ms のレース」に依存する形から決定的な形に改善）。既存の end-to-end 側（`shutting` 直後の `fetch` が reject）も pass |
| AC-5 | シャットダウン後の `/sse` は 503、ストリームを開始しない | **満たす** | `src/server/routes/sse.ts:50-52` の早期 return。テスト `GET /sse after shutdown responds 503 without starting a stream` が pass（`content-type` が `text/event-stream` でないことも検証） |
| AC-6 | シャットダウン後に `/sse` を叩いても `clientCount` が 0 のまま | **満たす** | `GET /sse after shutdown does not register a client` / `shutdown resets clientCount to zero and refuses further clients` が pass |
| AC-7 | 接続済み SSE の body が keep-alive を待たず EOF に達する | **満たす** | `shutdown ends connected streams without waiting for the keep-alive interval` が pass。`stream.onAbort(cleanup)` が `clients.add(client)` より前に移動（`sse.ts:78-79`）しても per-client abort の効果は不変であることを確認 |
| AC-8 | client 1 本あたりの abort リスナーが keep-alive 周回で増えない + positive control | **満たす**（退化経路が塞がれた） | `does not accumulate abort listeners per client` が pass。1 ラウンド目に指摘された `if (reader)` による無言退化が `if (!reader) throw` に置換され（`sse.test.ts:170-172`）、body 読み捨てが必ず実行される |
| AC-9 | 既存のシャットダウン関連テストが引き続き通る | **満たす** | `pnpm test`: **27 files / 268 tests all pass**。merge-base（`46cc093`）で実測した基準値は **25 files / 251 tests** なので **+2 files / +17 tests**。`pnpm typecheck` / `pnpm lint`（109 files）/ `pnpm format:check`（109 files）もすべて green |
| AC-10 | 手動確認（ブラウザタブ常時オープン × Ctrl+C 10 回、所要時間・警告有無の記録） | **未実施** | Phase 4 の作業項目（→ W-001）。実ブラウザ `EventSource` / 10 分放置 / Node 24 × macOS は本レビューでも未カバー |

**総括: AC-1〜AC-9 は満たす。AC-10 のみ未実施（Phase 4 の作業項目）。AC-3 は実装が満たしているが、AC の文言が旧 API を指したまま（→ W-103）。**

#### Issue の唯一の要件に対するコードパスの再追跡（新しい手順順序）

```
src/index.ts:172 shutdown(signal)
  ├─ shuttingDown 二重押しガード → process.exit(1)              [有界]
  ├─ console.log() / logger.info() / intro()                     [同期]
  ├─ await server.shutdown()                                     ← 唯一の await
  │    src/server/index.ts:259 shutdown()
  │      ├─ Promise.withResolvers() で memo を「先に」公開       [同期]
  │      └─ runShutdown()
  │           1. const closing = close()      同期（リスナー即停止・memo 化）
  │           try {
  │             2. sse.shutdown()             同期
  │             3. watcher.close()            同期
  │             4. closeAllConnections()      同期
  │           } catch { failure = {error} }   ← 手順 2〜4 のエラー分離
  │           5. await withTimeout(closing, 2000)   ← 唯一の待機点
  │           6. timed-out なら logger.warn
  │           7. failure があれば throw       ← rethrow
  ├─ catch → logger.error("Failed to shut down server:", e)      [reject でも到達]
  ├─ outro("Server stopped. Bye!")
  └─ process.exit(0)
```

**無界の待機点は存在しない。** 新設の rethrow 経路（手順 7）を実機で検証した:

| 注入 | 試行 | exit | elapsed | 警告 | `Server stopped` |
|---|---|---|---|---|---|
| 手順 2 の直後に `throw`（sse.shutdown() は実行済み） | 3 | **0** | 40〜49ms | なし | あり |
| `try` の冒頭で `throw`（手順 2〜4 を丸ごと飛ばす・SSE 接続あり） | 2 | **0** | 2090 / 2070ms | **あり** | あり |

どちらも `[peek] Failed to shut down server: Error: INJECTED ...` を出したうえで `outro()` → `process.exit(0)` に到達しており、**「手順 2〜4 が throw しても必ず有界時間で exit 0」が実機で成立する**。1 ラウンド目に指摘された「手順のいずれかが throw すると `close()` に到達せずハングしうる」は構造的に解消されている（`close()` が `try` の外・手順 1 にあるため）。

その他の経路:

- `closing` が予算内に reject した場合 → `withTimeout` が透過して `runShutdown` が reject → CLI の `catch` → `exit(0)`。
- 予算切れ後に `closing` が reject した場合 → `withTimeout` が `then(_, reject)` を張ったまま（already-settled への `reject` は no-op）なので unhandled rejection にならない。
- ハンドラ登録前（`startServer` 完了前）の SIGINT → Node の既定動作で終了。
- `Promise.withResolvers` は Node 22.0.0 以降。`package.json` の `engines.node` は `>=22.0.0` でちょうど一致（→ N-102）。

#### PR 本文と実装の食い違い

**PR 本文は 1 ラウンド目の修正（`b8e5da3`）を 1 つも反映しておらず、`3693d5d` 時点の記述のまま。** Phase 4 で以下をすべて更新すること。

**A. 事実と異なる記述（6 件）**

| # | PR 本文の記述 | 現在の実装 | 正しい記述 |
|---|---|---|---|
| 1 | 「`shutdown()` に `timeoutMs` を注入可能にし、タイムアウト経路を自動テストで検証」 | `ServerInstance.shutdown` は `() => Promise<void>`。予算は `startServer(config, { shutdownTimeoutMs })`（`src/server/index.ts:43-49, 157`） | 「`startServer()` の第 2 引数 `StartServerOptions.shutdownTimeoutMs` で予算を注入可能にし（ADR-008）、`shutdown()` は引数なしに戻した。memo 化により 2 回目以降無視される契約の矛盾を型のレベルで解消している」 |
| 2 | 「`"closeAllConnections" in server` の `in` ナローイングを `isHttpServer` 型述語に置換」 | **撤回済み。`in` ナローイングのまま**（`src/server/index.ts:237`）。`isHttpServer` は `src/` に存在しない | 記述を削除し、「`in` ナローイングを維持する（ADR-004 改訂）。手書き型述語は本体と述語の整合をコンパイラが検証しない未検証アサーションであり、CLAUDE.md の型安全性原則に照らすと後退のため」に差し替え |
| 3 | 「`ServerInstance` から未使用の `close` / `sseCloseAll` を削除」 | `watcher` **も**削除され、`ServerInstance` は `shutdown` のみ（`src/server/index.ts:51-62`） | 「`ServerInstance` から `close` / `sseCloseAll` / `watcher` を削除し、`shutdown` の 1 メソッドに絞った（ADR-005 の削除基準を `watcher` にも一貫適用）」 |
| 4 | 「`server.close()`（リスナー停止）を `closeAllConnections()`（再接続を誘発する破棄）より**先**に呼び」 | `close()` は**手順 1**。`sse.shutdown()` / `watcher.close()` / `closeAllConnections()` の**すべて**より先 | 「`server.close()`（リスナー停止）を**手順 1** に置き、再接続を誘発しうる操作（SSE ストリームの abort、ソケット破棄）のすべてより先に実行する。Issue 修正案 1 と同じ順序」 |
| 5 | 「`pnpm test`: **27 files / 266 tests all pass**（変更前 251 → 15 件追加）」 | **27 files / 268 tests**（merge-base `46cc093` は 25 files / 251 tests、実測） | 「27 files / 268 tests all pass（変更前 25 files / 251 tests → **2 files / 17 tests 追加**）」 |
| 6 | 判別性テーブルの 2 行:<br>・「プロセスが SIGINT 1 回で exit code 0 で終了する / `spawn` + 実 SIGINT / **起動 354ms / SIGINT→exit 0**」<br>・「タイムアウト警告が出る…／`index.test.ts` / **`{timeoutMs: 0}` で warn 1 回**」 | 前者は「起動 354ms / exit 0」では判別性を示せない（1 ラウンド目に「ハング注入でも PASS」と指摘され、`Server stopped` の assert・`elapsedMs < 2000`・警告の不在で塞いだ）。後者の API は `{ shutdownTimeoutMs: 0 }` | 前者を「`shutdown()` を永久ハングさせると `Server stopped` の assert で fail することを実測（本レビューで 2 パターン再現）」に、後者を「`startServer(..., { shutdownTimeoutMs: 0 })` で warn 1 回 / 既定で 0 回」に差し替え。テスト層の表記も `src/server/index.test.ts` と明示する（`src/index.shutdown-process.test.ts` ができて `index.test.ts` が曖昧になった） |

**B. 記述が欠けている実装変更（3 件）**

| # | 欠けている内容 | 該当箇所 |
|---|---|---|
| 7 | **手順 2〜4 のエラー分離と rethrow** — 手順 2〜4 が throw しても有界待機と警告を必ず実行し、その後で rethrow する。本 PR で最も要件に直結する構造変更なのに PR 本文に一言も無い | `src/server/index.ts:221-253` |
| 8 | **再入ガードの `Promise.withResolvers` 化** — memo を手順の実行より**前**に公開し、再入ガードが「手順が同期であること」に依存しないようにした | `src/server/index.ts:256-270` |
| 9 | **`stream.onAbort(cleanup)` を `clients.add(client)` より前に移動** — 2 つの間に abort が挟まると client が `clients` に残り続ける経路を塞いだ | `src/server/routes/sse.ts:78-79` |

**C. 追加が望ましいテスト行（判別性テーブル）**

- `leaves no pending timer behind when the promise settles inside the budget`（`clearTimeout` の回帰ガード。1 ラウンド目に「両方削除しても 7 ケース全 PASS」と指摘されて追加された）
- `shutdown step order`（ADR-002 の順序を `serve()` スタブで同期的に検証。AC-4 の判別窓をレースから決定的な検証に強化）

**D. 一致していることを再確認した記述**

`src/lib/with-timeout.ts` の新規追加 / 既定 2 秒 / 予算ゼロ判定 `!(timeoutMs > 0)` / タイマーを `unref()` しない / 打ち切り時の `logger.warn` / `SseManager` のシャットダウンフラグと二重チェック / keep-alive の `node:timers/promises` 置換 / SIGINT・SIGTERM の受信ログ / 不採用 3 件（stdio drain・再 `closeAllConnections()`・`closeIdleConnections()` は `src/` に存在しないことを grep で確認）/ `pnpm typecheck` `pnpm lint` `pnpm format:check` が green。

#### `.issue/102/testing.md` と実装の整合

| 項目 | 判定 | 根拠 |
|---|---|---|
| 起動手順（`pnpm build` → `node dist/index.mjs ...`） | **一致** | worktree で実行して確認 |
| HTML モードの対象 `testdata/html/01-basic-structure.html` | **実在** | 確認済み。同ファイルで SSE / ライブリロード / SIGINT 終了を実測 |
| 警告文の検索キー `did not close within` と実文言 | **一致** | 実出力 `[peek] HTTP server did not close within 2000ms — giving up and leaving the remaining sockets to the caller.` |
| `Received SIGINT, shutting down...` の確認 | **一致** | 実測。SIGTERM 時は `Received SIGTERM, ...` |
| 項目 1「`^C` と同じ行に連結しない / 枠が崩れない」 | **一致** | 実 TTY（pty）で `^C` → 空行 → `[peek] Received SIGINT, ...` → `┌ Shutting down...` → `│` → `└ Server stopped. Bye!` |
| 項目 1「タイムアウト警告は枠内に 1 行割り込むのが正常」（**W-002 の修正**） | **一致** | 上記の実出力ブロックと一字一句一致 |
| エッジケース 1「通常は `Force exiting...` が出ず exit 0」（**W-003 の修正**） | **一致** | 12/12 で exit 0・`Force exiting...` 未出力。遅いシャットダウンを作れば 2/2 で exit 1 + `Force exiting...` |
| エッジケース 3（SIGTERM で exit 0） | **一致** | 3/3 exit 0 / 39〜40ms |
| エッジケース 4（SSE 無しのベースライン） | **一致** | 3/3 exit 0 / 38〜66ms、警告なし |
| 「ライブリロード」「`--port` 衝突」「連続起動でのポート再利用」 | **一致** | 下記「既存機能への回帰」で全項目を実測 |
| **line 240「リスニングハンドルは手順 2 の時点で閉じている」** | **食い違い（軽微）** | `close()` は現在**手順 1**。主張自体（打ち切り後もポートは解放済み）は実測で成立するが、手順番号が古い → W-102 |
| **line 23「`dist/index.mjs` 128.39 kB が生成される」** | **食い違い（軽微）** | 現在 **130.90 kB** → W-102 |

#### 既存機能への回帰（すべて実機で確認）

すべて worktree の `pnpm build` 成果物（`dist/index.mjs`）を `--host 127.0.0.1 --no-open` で起動して実施。

**1. ライブリロード（ディレクトリモード）— 回帰なし**

```
$ curl -N http://127.0.0.1:52032/sse
event: file-changed
data: {"path":"README.md"}      ← Markdown を編集

event: tree-changed
data: {}

event: file-changed
data: {"path":"ADDED.md"}       ← ファイル追加

event: tree-changed
data: {}

event: file-changed
data: {"path":"ADDED.md"}       ← ファイル削除

event: tree-changed
data: {}
```

`GET /` = 200、`GET /api/tree` = `[{"name":"README.md","path":"README.md","type":"file"}]`、`GET /api/content?path=README.md` は shiki ハイライト済み HTML（`<pre class="shiki shiki-themes vitesse-light vitesse-dark" ...>`）。503 の早期拒否・②の再チェック・`onAbort` の登録順序変更・`node:timers/promises` 置換のいずれも通常時の SSE を壊していない。

**2. ライブリロード（HTML ファイルモード）— 回帰なし**

`node dist/index.mjs testdata/html/01-basic-structure.html` で起動。`GET /` = 200、トップレベル HTML に `EventSource` のインラインスクリプトが 1 件。ファイル編集で `event: file-changed / data: {}` が届く。SIGINT 3/3 で exit 0 / 38〜40ms。

**3. `--port` 衝突時の起動失敗 — 回帰なし。新しい手順順序 / `closePromise` の memo 化との競合なし**

```
$ node dist/index.mjs <dir> --host 127.0.0.1 --port 52378 --no-open   # 2 つ目
◇  Failed to start server
└  Port 52378 is already in use
second: exit=1 elapsed=161ms
```

- listen エラー経路（`src/server/index.ts:195-200`）は `sse.shutdown()` + `watcher.close()` のみを呼び、`close` / `closePromise` は**その時点でまだ宣言されていない**（宣言は L207-213、listen 待ちの `await` より後）。したがって memo 化と listen エラー経路が競合する余地は構造的に無い。実機でもハングせず 161ms で exit 1。
- 1 つ目のプロセスは無傷（`GET /` = 200）で、その後の SIGINT で exit 0。

**4. SIGTERM 経路 — 回帰なし**

3/3 で exit 0 / 39〜40ms、`[peek] Received SIGTERM, shutting down...` を出力。SIGINT とシグナル名で判別可能。

**5. 2 回目のシグナルによる force exit — 分岐は健在、正常系では到達しない（設計どおり）**

押下間隔 0 / 5 / 20 / 50ms × 各 3 = 12 試行すべて exit 0・`Force exiting...` 未出力。1 回目のシャットダウンを 2 秒かかる状態にすると 2/2 とも exit 1・`Force exiting...` 出力・391ms / 381ms。`testing.md` エッジケース 1 の書き換え後の記述と完全に一致する。

**6. CLI の出力（実 TTY）— 回帰なし**

expect + pty で実 `^C` を送った出力（エスケープを可読化）:

```
└  Press Ctrl+C to stop

^C
[peek] Received SIGINT, shutting down...
┌   Shutting down...
│
└  Server stopped. Bye!
...
GOTSTATUS=0
```

`^C` のエコーと `[peek] Received SIGINT, ...` は `console.log()` の空行で分離され同じ行に連結していない。clack の枠も崩れていない。exit code は 0。

**7. `ServerInstance` からの `watcher` / `close` / `sseCloseAll` 削除の影響 — 残存参照なし**

`src/` 全体を grep して `sseCloseAll` 0 件、`closeAll` 0 件、`ServerInstance` 経由の `.watcher` / `.close()` 0 件。`ServerInstance` を消費するのは `src/index.ts:149` の `startServer()` → `server.shutdown()`（L185）のみ。`pnpm typecheck` も green。

**8. `src/__test_shutdown_fixture__` — ビルド成果物にも作業ツリーにも残らない**

- `pnpm build` 後の `dist/` は `index.mjs` 1 ファイルのみ。`grep -rn "__test_shutdown_fixture__" dist/` は 0 件（tsdown のエントリが `src/index.ts` のみでテストは辿られない）。
- `npm pack --dry-run`: `LICENSE` / `README.md` / `dist/index.mjs` / `package.json` の 4 ファイルのみ（`files: ["dist"]`）。fixture もテストファイルも配布物に入らない。
- `pnpm test` 後に `src/__test_shutdown_fixture__` は存在せず `git status --porcelain` も空。**テストを意図的に失敗させた 2 回のミューテーション実行後でも残留なし**（`afterAll` が失敗時にも走ることを確認）。

**9. その他の閲覧機能 — 回帰なし**

Markdown 単一ファイルモード + `--css ./custom.css` でカスタム CSS が HTML に注入されることを確認（`color:red` が 1 件ヒット、`GET /` 56,955 bytes）。shiki ハイライト・テーブル・ディレクトリブラウズ・ツリー API も上記 1 のとおり正常。

**10. 連続起動でのポート再利用 — 回帰なし（タイムアウト経路でも成立）**

正常終了直後の同一ポート再 bind: OK。**タイムアウトで打ち切った場合**（手順 2〜4 を throw で飛ばして 2 秒で打ち切り、SSE ソケットが残った状態で exit 0）でも直後の再 bind が成功し `EADDRINUSE` にならないことを確認。`testing.md` line 240 の設計上の主張は成立している（手順番号の表記だけが古い → W-102）。

**11. 品質ゲート**

`pnpm typecheck`（エラーなし） / `pnpm lint`（109 files, no fixes） / `pnpm format:check`（109 files, no fixes） / `pnpm test`（27 files / 268 tests pass）すべて green。

#### AC-1 テストの判別性を独立に再現（1 ラウンド目の Blocker の検証）

`triage.md` の `src/server/shutdown-process.test.ts:AC-1テスト/判別性` = fix が実効しているかを、worktree で 2 パターンのミューテーションを注入して確認した。

| ミューテーション | 結果 |
|---|---|
| `runShutdown()` の**冒頭**に `await new Promise(() => {})`（`close()` にも到達しない） | **fail** — `peek did not exit after SIGINT.`（10 秒のレースで捕捉） |
| 手順 1〜4 の**後**に `await new Promise(() => {})`（同期部は完走 → イベントループ枯渇で Node が自然に exit 0） | **fail** — `AssertionError: expected '...' to contain 'Server stopped'` |

後者が 1 ラウンド目に「ハング注入でも exit 0 で自然終了し PASS する」と指摘されたケースそのもので、追加された `expect(output).toContain("Server stopped")` が正しく捕捉している。**AC-1 の自動テストは今回、真に判別性を持つ。**

#### Blockers

なし

#### Warnings

- **[W-101]** PR 本文が 1 ラウンド目の修正を一切反映しておらず、現在の実装と食い違う
  - 場所: PR #116 本文「変更内容」「付随整理」「Test plan」全体
  - 理由: 事実と異なる記述 6 件（`shutdown({ timeoutMs })` API / `isHttpServer` 型述語 / `ServerInstance` の削除範囲 / `close()` の順序の表現 / テスト件数 266 → 268・251 → +17 / 判別性テーブル 2 行）と、記述が欠けている実装変更 3 件（手順 2〜4 のエラー分離と rethrow / `Promise.withResolvers` 再入ガード / `onAbort` の登録順序）がある。とくに **`isHttpServer` は「実装した」と書かれているのに `src/` に存在しない**ため、PR 本文だけを読んだレビュアー・将来の読者を確実に誤らせる。**手順 2〜4 のエラー分離は本 PR で最も要件（必ず終了する）に直結する構造変更であるにもかかわらず、PR 本文に一言も無い。**
  - 提案: 上記「PR 本文と実装の食い違い」の A / B / C をそのまま反映する。Phase 4 の AC-10 記録追記と同じタイミングで行うのが自然。

- **[W-102]** `.issue/102/testing.md` に実装と食い違う記述が 2 箇所残っている
  - 場所: `.issue/102/testing.md:240`（「リスニングハンドルは**手順 2** の時点で閉じている」）、同 `:23`（「`dist/index.mjs` **128.39 kB** が生成される」）
  - 理由: `close()` は現在**手順 1**（`src/server/index.ts:220`）で、`sse.shutdown()` / `watcher.close()` / `closeAllConnections()` のすべてより先に走る。ビルドサイズも実測 **130.90 kB**。どちらも主張の中身（ポートは打ち切り後も解放済み／`pnpm build` で `dist/index.mjs` が出る）は実測で成立しているので**検証をブロックはしない**が、Phase 4 の検証者が「手順 2」を根拠に順序を読み違えるリスクがある。
  - 提案: line 240 を「リスニングハンドルは**手順 1**（シャットダウンの最初の操作）の時点で閉じている」に、line 23 のサイズを実測値に更新するか「約 130 kB」のような幅のある表現にする。

- **[W-103]** `.issue/102/plan.md` の受け入れ基準 AC-3 が、存在しない API を指したままになっている
  - 場所: `.issue/102/plan.md:25`（AC-3 本文の `shutdown({ timeoutMs: 0 })`）。同様の陳腐化が `:290-298`（`ServerInstance.shutdown(options?)`）、`:311, :322`（`isHttpServer`）、`:335`（「リスニングハンドルは手順 2 の時点で」）、`:516`（「`watcher` は残す」）にもある。
  - 理由: 設計判断の変更自体は `adr.md` に正しく記録されている（ADR-004 が「型述語への置き換えは撤回」に改訂、ADR-008 が `shutdownTimeoutMs` への移動を追加）。ただし **plan.md の AC 表は「受け入れの契約」として参照される文書**であり、AC-3 を文字どおり実行しようとすると `shutdown({ timeoutMs: 0 })` はコンパイルすら通らない。実装は AC-3 の**趣旨**（予算ゼロで決定的にタイムアウト分岐 + 警告、既定値で偽陽性なし）を満たしているので Blocker にはしない。
  - 提案: 最低限 AC-3 の文言を `startServer(config, { shutdownTimeoutMs: 0 })` に更新する。plan.md 全体を追随させないなら、AC 表の直下に「本計画から変更された設計判断は ADR-004 改訂・ADR-008 を参照」と 1 行入れて、どちらが正なのかを読者が迷わないようにする。

#### Notes

- **[N-101]** `closing` が予算内に reject した場合、手順 2〜4 の `failure` が握りつぶされる
  - `src/server/index.ts:245` の `await withTimeout(closing, ...)` が reject すると、L251-253 の `if (failure) throw failure.error` に到達しない。両方とも CLI の同じ `catch` に落ちて `exit(0)` するので**終了性には影響しない**（診断ログに出る error が入れ替わるだけ）。`close()` が reject しうるのは `ERR_SERVER_NOT_RUNNING` などの周辺ケースのみで、実際に踏む経路は現状存在しない。修正は不要だが、将来 rethrow のログを頼りに調査する際の前提として記録しておく。

- **[N-102]** `Promise.withResolvers` は Node 22.0.0 で入った API で、`engines.node: ">=22.0.0"` とちょうど一致
  - `package.json` の下限そのものなので違反ではない。`tsdown` の target も `node22.0.0`。Node 22.22.1 / 実 CLI で動作を確認済み。下限を下げる変更が将来入る場合はここが引っかかる、という注意点のみ。

- **[N-103]** `logger.warn` は `console.warn` = **stderr** に出る
  - `testing.md` の計測レシピはすべて `2>&1` を付けているので取りこぼさない。項目 1 の対話端末手順（リダイレクトなし）でも端末には出る。整合している。

- **[N-104]** 実機計測サマリ（worktree の `dist/index.mjs`、Node v22.22.1 / macOS）

  | 条件 | 試行 | exit | wall（`node -e` 約 30ms 込み） | 警告 |
  |---|---|---|---|---|
  | ディレクトリ + SSE 1 本 + SIGINT | 5 | 0 | 38〜41ms | なし |
  | ディレクトリ + SSE 3 本 + SIGINT | 3 | 0 | 39〜52ms | なし |
  | ディレクトリ + SSE なし + SIGINT | 3 | 0 | 38〜66ms | なし |
  | ディレクトリ + SSE 1 本 + SIGTERM | 3 | 0 | 39〜40ms | なし |
  | HTML ファイルモード + SSE 1 本 + SIGINT | 3 | 0 | 38〜40ms | なし |
  | 実 TTY で `^C` | 2 | 0 | 即時 | なし |
  | 手順 2 の直後で throw（rethrow 経路） | 3 | **0** | 40〜49ms | なし |
  | 手順 2〜4 を丸ごと throw で飛ばす（有界待機経路） | 2 | **0** | 2090 / 2070ms | **あり** |
  | 同上 + SIGINT 2 回（force exit 経路） | 2 | **1** | 391 / 381ms | なし |
  | SIGINT 2 回・正常系（gap 0/5/20/50ms） | 12 | 0 | — | なし |
  | `--port` 衝突（2 つ目の起動） | 1 | 1 | 161ms | — |

  **正常系で警告が一度も出ないこと（AC-3 の偽陽性なし）と、手順 2〜4 が壊れても 2 秒で打ち切って exit 0 になること（AC-1 / AC-2）の両方を、新しい手順順序の実機で確認できている。**

- **[N-105]** `SHUTDOWN_TIMEOUT_MS = 2_000` は CLI から変更できない（注入口は `startServer()` のオプションのみ = テスト専用）。Phase 4 で「毎回警告が出る」観測が得られた場合は真因が生きている可能性が高いので、計画の「リスクと注意点」どおり別 Issue で追跡すること。

- **[N-106]** 1 ラウンド目 N-001 で報告した「作業ツリーの並行書き換え」は今回発生していない。本レビューの破壊的検証はすべて隔離 worktree（`scratchpad/wt-req-r2`）で行い、各ミューテーションの直後に `git diff --stat` が空であることを確認して復元した。レビュー終了時点で worktree は削除済み、メインの作業ツリーには本ファイル以外の変更を加えていない。
