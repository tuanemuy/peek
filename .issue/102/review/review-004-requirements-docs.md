# Requirements & Docs Review #004

**Date:** 2026-07-25
**Round:** 4回目

---

## Summary
- Blockers: 0
- Warnings: 1
- Verdict: **APPROVED**

Phase 4（ブラウザ検証）への移行は **Go**。`testing.md` は記載どおり実行できる（ブラウザ操作を伴わない全コマンドを実機で実行して確認）。唯一の Warning は PR 本文のみに閉じたドキュメント追随漏れで、実装・`plan.md` / `testing.md` / `adr.md` には波及しない。

---

## 検証環境

- 隔離 worktree: `scratchpad/wt-req-r4`（detached HEAD `3aff692`）。`pnpm install --frozen-lockfile` → `pnpm build` 済み。
- メインの作業ツリーは本ファイル以外いっさい編集していない。フォールト注入は worktree の `dist/`（gitignore 済み）に別名でコピーしたバンドルに対してのみ行い、実施後に削除して `git status --porcelain` が空であることを確認した。
- Node v22.22.1（既定）/ v24.18.0（`nix shell nixpkgs#nodejs_24`）/ macOS Darwin 25.4.0。
- 起動はすべて `--host 127.0.0.1` + `--no-open` + 空きポート。子プロセスは毎回 `wait` / `kill` で回収し、レビュー終了時に `pgrep` で残存ゼロを確認済み。

---

## 3ラウンド目指摘の解消状況

- **[W-001] 解消** — `.issue/102/testing.md` 項目 4 の観察時間が **2 分 → 4 分**に延長され（`:142`）、さらに「観察時間を 4 分にする理由」（`:147`）としてタイムラインが明記された。**独立に再計算して一致を確認した。** `src/core/sse-constants.ts` は `SSE_MAX_RETRIES = 10` / `SSE_INITIAL_RETRY_MS = 1000` / `SSE_MAX_RETRY_MS = 30000`。両クライアント実装とも `delay = min(1000 * 2^(n-1), 30000)` かつ `retryCount > 10` で停止するため、Ctrl+C からの試行時刻は **1 → 3 → 7 → 15 → 31 → 61 → 91 → 121 → 151 → 181 秒**で、停止は 10 回目が失敗した約 181 秒後。4 分（240 秒）は 181 秒 + 59 秒のマージンで十分。**2 分では 7 回目（121 秒）までしか見えず**、期待結果「10 回で停止」を観測できないまま「まだ続いている」を FAIL と誤記録しうるという指摘は正しく、修正も妥当。
  - **両クライアント実装で同一であることを確認した。** `src/client/lib/sse.ts` は `onerror` で `retryCount++` → `retryCount > SSE_MAX_RETRIES` で `logger.warn` して停止、`src/server/renderer/html-document.tsx` のインラインスクリプトは同じ式で `return` して停止。リトライカウンタのリセット手段だけが異なる（前者 = 接続後 5 秒の `stableTimer`、後者 = `es.onopen`）が、サーバー停止後は接続が即 refuse されるためどちらもリセットされず、タイムラインは完全に一致する。
- 併せて、他レイヤーの 3 ラウンド目指摘の実装側も突き合わせた（本観点の範囲内で確認できるもの）。
  - `step()` の条件型化: `src/server/index.ts` に `const step = <T>(run: () => T extends PromiseLike<unknown> ? never : T)` として反映済み。`adr.md` ADR-002（`:136` 以降）と `plan.md`（`:350`）に判断が記録されている。
  - `watcher` のテストスタブ: `src/server/index.test.ts` の `withStubbedServer` に `vi.doMock("../lib/watcher.js", ...)` が追加され、`calls` が `["close", "sse.shutdown", "watcher.close", "closeAllConnections"]` の **4 要素**になった。docstring も「`serve()`, `SseManager.shutdown()` and `FileWatcherHandle.close()` をスタブし steps 1-4 を記録する」に更新済み（3 ラウンド目 Test W-001 の後半も解消）。
  - `src/index.ts` のコメント圧縮: 4 行 → 1 行（`// "Server stopped" is asserted by src/index.shutdown-process.test.ts.`）。

---

### Requirements & Docs

#### 受け入れ基準の検証

| AC | 内容 | 判定 | 根拠 |
|---|---|---|---|
| AC-1 | SSE 接続中に SIGINT 1 回で 5 秒以内・exit code 0 | **PASS** | `src/index.shutdown-process.test.ts` が `spawn` + 実 SIGINT で `Server stopped` の出力・exit 0・`elapsedMs < 2000`・警告なしを assert（判別性は「無限ハング時は exit 0/6ms でも `Server stopped` が出ない」で担保）。実機でも `dist/index.mjs` に SSE 接続 1 本を張って `kill -INT`：ディレクトリモード `exit=0 elapsed=41ms`、HTML ファイルモード `exit=0 elapsed=39ms`、Node 24.18.0 で `~39ms`、実 TTY（`script` で pty 割当、`isTTY=true`）で `~100ms` |
| AC-2 | `server.close()` が永久に解決しなくても有限時間で settle | **PASS** | `src/lib/with-timeout.test.ts`（8 ケース）で永久保留 promise を注入。**加えて本レビューで直接検証した** — `dist` バンドルの `server.close((err) => ...)` を `server.close(() => {})`（コールバックを絶対に呼ばない）に差し替えた版で SIGINT 1 回 → `exit=0 elapsed=2089ms`（= 予算 2,000ms + オーバーヘッド）。`plan.md` が「間接検証にとどまる」と明記している範囲と矛盾しない |
| AC-3 | `shutdownTimeoutMs: 0` で決定的に警告 / 既定では偽陽性なし | **PASS** | `src/server/index.test.ts` の 2 ケース。実機のフォールト注入でも `[peek] HTTP server did not close within 2000ms — giving up and leaving the remaining sockets to the caller.` が 1 行出力され、`testing.md:74` の検索キー `did not close within` と完全一致。正常系（上記 AC-1 の全試行）では 1 度も出なかった |
| AC-4 | `shutdown()` から戻った直後にリスナーが閉じている | **PASS** | `shutdown step order` テストが `instance.shutdown()` の**直後に同期的に** `calls` を読み `["close", "sse.shutdown", "watcher.close", "closeAllConnections"]` を assert。実機でも Ctrl+C 直後（1 秒以内）に同一ポートで再起動でき `EADDRINUSE` にならないことを確認（`testing.md` 既存機能への影響確認の 3 項目目） |
| AC-5 | シャットダウン後の `/sse` は 503 でストリーム未生成 | **PASS** | `sse.test.ts:84` `GET /sse after shutdown responds 503 without starting a stream` |
| AC-6 | シャットダウン後に `/sse` を叩いても `clientCount` が増えない | **PASS** | `sse.test.ts:95` `GET /sse after shutdown does not register a client` |
| AC-7 | 接続済み body が keep-alive 30 秒を待たず EOF | **PASS** | `sse.test.ts:105` `shutdown ends connected streams without waiting for the keep-alive interval`。実機でも `curl -N` の `/sse` がサーバー停止と同時に終了 |
| AC-8 | client 1 本あたりの abort リスナーが周回で増えない | **PASS** | `sse.test.ts:148` `does not accumulate abort listeners per client`。positive control 付き（`plan.md` の 4 実装 × 8 tick の実測表と整合） |
| AC-9 | 既存のシャットダウン関連テストが引き続き通る | **PASS** | `pnpm test` → **27 files / 271 tests all pass**（worktree で実行）。`pnpm typecheck` / `pnpm lint` / `pnpm format:check` もすべて green |
| AC-10 | 手動確認（10 回試行 + 観測記録） | **Phase 4 で実施** | `testing.md` 項目 1 / 5 に手順と記録項目が定義済み。「毎回警告なし」も等しく重要な観測結果として記録が義務づけられている（`:99`, `:167`）。本レビューではその前提条件（コマンドが実行可能で、期待結果が実測と一致すること）を確認した |
| AC-11 | 手順 2/3/4 のいずれが throw しても後続手順と有界待機が走る | **PASS** | **検証可能な形で書かれている**（`plan.md:33` が「`serve()` / `SseManager.shutdown()` / `createFileWatcher()` をスタブして各手順に throw を注入し、`calls` の並び・経過時間・警告回数・throw された値で検証する」と手段を明示）。実装側の `describe("shutdown error isolation")` の 3 ケースがそれと 1 対 1 に対応する: ①手順 2 throw + `closing` 永久保留 → `calls` 4 要素・`elapsedMs >= 25`・警告 1 回・素の `Error`（`AggregateError` でないことも assert）、②手順 3 + 手順 4 の両 throw → `AggregateError.errors` が `["watcher boom", "socket boom"]`、③手順 4 throw + 予算内 reject → `["socket boom", "close boom"]`。`plan.md` のテスト方針表（`:622`）にも AC-11 の行が追加済み |

**Issue の唯一の要件（「Ctrl+C を 1 回押したら必ず有限時間で peek プロセスが終了する」）は満たされている。** 終了性の保証は「手順 1 の `close()` → 手順 2〜4 の個別捕捉 → 手順 5 の有界待機」という単一経路に集約されており、その経路が壊れる 2 通り（手順の失敗で有界待機に到達しない / 待機が無限）を自動テストと実機フォールト注入の双方で塞いでいることを確認した。加えて 2 回目のシグナルによる force exit（`process.exit(1)`）も保険として生きている（下記実機検証）。

#### ドキュメント 4 点の相互整合

| 項目 | PR 本文 | plan.md | testing.md | adr.md | 実装 |
|---|---|---|---|---|---|
| `close()` が手順 1 | ○ | ○（`:333`） | 該当なし | ○（ADR-002） | ○ |
| 手順ごとのエラー分離 / `AggregateError` | ○ | ○（AC-11, `:622`） | 該当なし | ○（ADR-002） | ○ |
| `step()` の条件型化 | **×（未記載）** | ○（`:350`） | 該当なし | ○（ADR-002 Status/Decision/Consequences） | ○ |
| `watcher` スタブ追加 / `calls` 4 要素 | **△（`serve()` スタブとのみ記載）** | ○（`:451`, `:622`, `:754`） | 該当なし | 該当なし | ○ |
| 再入ガード（`Promise.withResolvers`） | ○ | ○ | 該当なし | ○（ADR-009） | ○ |
| `in` ナローイング維持（型述語は撤回） | ○ | ○（`:672` 周辺） | 該当なし | ○（ADR-004） | ○ |
| `ServerInstance` = `{ shutdown }` のみ | ○ | ○（`:317`） | 該当なし | ○（ADR-005） | ○ |
| keep-alive を `node:timers/promises` へ | ○ | ○ | ○（既存機能への影響確認） | ○（ADR-006） | ○ |
| 観察時間 4 分 / 181 秒 | 該当なし | 該当なし | ○（`:142`, `:147`） | 該当なし | ○（`sse-constants.ts` と一致） |
| テスト件数 271 / 27 files | ○ | 該当なし | 該当なし | 該当なし | ○（実測一致） |

- **テスト件数の記述は正しい。** worktree で `pnpm test` → `Test Files 27 passed (27)` / `Tests 271 passed (271)`。PR 本文の「merge-base は 25 files / 251 tests なので +2 files / +20 tests」も検算した: 新規 2 ファイル（`with-timeout.test.ts` 8 件 + `index.shutdown-process.test.ts` 1 件 = 9 件）、`server/index.test.ts` 5 → 12（+7）、`sse.test.ts` 7 → 11（+4）で **9 + 7 + 4 = 20**。PR 対象ファイルにテストファイルの削除は無い。
- **AC-11 の新設を PR 本文に反映する必要は無い。** PR 本文は一貫して AC 番号を使わず「検証 / 層 / 判別性の実測」の 3 列で書かれており、AC-11 の内容自体は「手順ごとのエラー分離と `AggregateError`」の行として既に載っている。番号だけを持ち込むと本文の記法が壊れる。
- **`adr.md` に残る `sseCloseAll()` の記述（`:18`, `:132`, `:389`）は修正前の状態の説明**であり、現行 API の誤記ではない。`:389` は ADR-005 が「なぜ削除するか」を述べている文脈。
- **`plan.md:682` の「手順 2 でリスニングハンドルを閉じている」**は 3 ラウンド目 N-004 のとおり計画レビュー当時の履歴記録であり、現行設計を述べる箇所（`:330`, `:342`, `:366`）はすべて「手順 1」。ADR-002 / ADR-007 も手順 1 で統一。今回も書き換え不要と判断する。

#### `testing.md` の Phase 4 実行可能性（記載コマンドを実機で実行）

| 記載箇所 | 検証内容 | 結果 |
|---|---|---|
| `:19-21` 推奨起動 | `pnpm build` → `node dist/index.mjs <dir> --host ... --port ... --no-open` | **OK**。`dist/index.mjs` 生成、`GET /` 200、SIGINT で `Server stopped. Bye!` / exit 0 |
| `:23` `scripts.build` の内訳 | `build:css && build:client && build:favicon && tsdown` | **一致** |
| `:24` `bin.peek` = `dist/index.mjs` | `package.json` | **一致** |
| `:30-31` 代替起動（フルビルド不要） | `pnpm build:css && build:client && build:favicon` → `node --import ./src/loaders/css.mjs --import tsx/esm src/index.ts ...` | **OK**。`GET /` 200、`GET /sse` `200 text/event-stream`、SIGINT で正常終了 |
| `:39-40` `pnpm dev` / `dev:server` / `start` を使わない理由 | `package.json` の定義 | **一致**（`dev` は `pnpm dev:css & trap ... ; pnpm dev:server`、`start` は `node dist/index.mjs`） |
| `:45` HTML ファイルモード | `testdata/html/01-basic-structure.html` | **存在する**。トップレベル文書に `new EventSource` が 1 箇所（iframe 側ではない）ことも確認 |
| `:59-70` 計測レシピ | `node -e 'Date.now()'` + `kill -INT` + `wait` + `grep` | **OK**。`python3` 非依存の指摘どおり動作 |
| `:72` 実測例 `exit=0 elapsed=42ms` | 再測定 | **一致**（39〜41ms） |
| `:74` 警告の検索キー | 実際の出力文字列 | **完全一致**（フォールト注入で実出力を確認） |
| `:146-147` 181 秒 / 4 分 | `sse-constants.ts` + 両クライアント実装から再計算 | **一致**（上記 W-001 の項） |
| `:174-177` Node 24 の入手 | `nix shell nixpkgs#nodejs_24 -c node --version` | **OK** → `v24.18.0`（記載どおり）。この Node で `dist/index.mjs` を起動し SIGINT で ~39ms・exit 0 も確認 |
| `:194` 2 回連続 Ctrl+C の期待結果 | 200ms 間隔で `kill -INT` × 2 | **一致**（`Force exiting...` は出ず exit 0） |
| `:197` force exit 経路が生きていること | `close()` を永久ハングさせた版に `kill -INT` × 2 | **一致**（`Force exiting...` / exit 1 / 273ms） |
| `:219` SIGTERM | `kill -TERM` | **一致**（`[peek] Received SIGTERM, shutting down...` / exit 0 / 40ms） |
| `:242` `--port` 衝突 | 同一ポートで 2 つ目を起動 | **一致**（`Port <n> is already in use` / exit 1 / 1 つ目は生存継続・孤児なし） |
| `:243` 連続起動でのポート再利用 | 終了直後に同一ポートで再起動 | **一致**（`EADDRINUSE` にならず `GET /` 200） |
| `:174` `flake.nix` が `nodejs_22` 固定 | `flake.nix:21` | **一致** |

**判定: Phase 4 は Go。** 記載のコマンドはブラウザ操作を伴うものを除いてすべて実行でき、期待結果は現在の実装の実測と一致した。誤りは 1 件も見つからなかった。

#### 既存機能への回帰（実機で確認）

- **ライブリロード（ディレクトリモード）:** `curl -N http://127.0.0.1:<port>/sse` を張った状態で対象ディレクトリの Markdown を **編集 / 追加 / 削除** した結果、3 操作すべてで `event: file-changed` + `event: tree-changed` が到達した（削除時も `path` 付きの `file-changed` → `tree-changed`）。`watcher` のテストスタブ追加はプロダクション経路に影響していない（スタブは `vi.doMock` でテストプロセス内に閉じており、`setupWatcher()` は素の `createFileWatcher()` を使う）。
- **ライブリロード（HTML ファイルモード）:** 対象 `.html` を上書き保存 → `event: file-changed` / `data: {}` が到達。トップレベル文書のみに `new EventSource("/sse")` が載ることも確認。
- **`--port` 衝突 / SIGTERM / 2 回目シグナルの force exit / ポート再利用:** 上表のとおりすべて期待どおり。force exit は正常系では到達しないため、`close()` を永久ハングさせた隔離バンドルで分岐に到達させて `Force exiting...` / exit 1 を実測した。
- **実 TTY での CLI 出力:** `script` で pty を割り当てて（`process.stdout.isTTY === true`）起動 → SIGINT。clack の枠（`┌ peek` … `└ Press Ctrl+C to stop` / `┌ Shutting down...` … `└ Server stopped. Bye!`）が崩れておらず、`[peek] Received SIGINT, shutting down...` の**前に空行が保たれている**ことを確認（`testing.md:100` の確認ポイント）。
- **その他ルート:** `GET /` 200 / `GET /api/tree` 200（Node 22 / 24 とも）。
- **品質ゲート:** `pnpm test` 271/271、`pnpm typecheck`、`pnpm lint`（109 files, no fixes）、`pnpm format:check`（109 files, no fixes）すべて green。

#### Blockers

- なし

#### Warnings

- **[W-001]** **PR 本文が 4 コミット目（`3aff692`）の実装変更に追随していない。** 2 点。
  1. **`step()` の条件型化が「変更内容」に載っていない。** これは 3 ラウンド目のレビューで入った production コードの変更で、ADR-002 の Status / Decision / Consequences と `plan.md:350` に判断として記録されている。PR 本文は同格の設計判断（再入ガードの `Promise.withResolvers` 化、手順ごとのエラー分離、`in` ナローイングの維持）をいずれも明記しているので、これだけが欠けているのは追随漏れである。**グループ B の箇条書きに 1 行**（例: 「手順ヘルパ `step()` のシグネチャを条件型にし、非同期な手順を型で拒む — async 化されると失敗が `failures` に載らず unhandled rejection でクラッシュするため」）を足せば埋まる。
  2. **テスト表の「シャットダウン手順の順序」行が `serve()` スタブとしか書いていない。** 実際のハーネス（`withStubbedServer`）は `serve()` / `SseManager.shutdown()` / `createFileWatcher()` の **3 つ**をスタブし、`calls` は 4 要素を固定している。判別性の列も 3 ラウンド目に追加された「手順 3（`watcher.close()`）を削除すると FAIL」を含んでいない（従来は手順 3 を消しても 271 passed だったことが、まさに 3 ラウンド目の指摘だった）。行の記述が**偽ではないが不完全**で、「何が回帰ガードされているか」を過小に伝えている。
  - **影響はドキュメントに閉じており、Phase 4 のブロッカーではない。** 実装・`plan.md` / `testing.md` / `adr.md` の 3 点はいずれも追随済みで、相互の食い違いも無い。マージ前に PR 本文を 2 行直せば足りる。

#### Notes

- **[N-001]** `testing.md` 項目 4 は DevTools Network の目視だけを手段としているが、**ディレクトリモードではブラウザコンソールに決定的な信号が出る。** `src/client/lib/sse.ts` は再接続ごとに `[peek] SSE reconnecting in <delay>ms (n/10)...`、上限到達時に `[peek] SSE connection lost after 10 retries, giving up.` を出力する（`src/lib/logger.ts` = `console.log` / `console.warn`、クライアントバンドルにも入っている）。「10 回で停止」の判定はこの 1 行で確定でき、Network エントリを数え間違えるリスクが消える。一方 **HTML ファイルモードのインラインスクリプトにはログが一切無い**（`html-document.tsx` の `onerror` は `return` するだけ）ので、そちらは Network を数えるしかない。項目 4 に「ディレクトリモードで実施し、コンソールの `giving up` 行を確定判定に使う」と 1 行足すと Phase 4 が安く確実になる（現状の記述が誤りというわけではないので Note に留める）。
- **[N-002]** `testing.md:147` の「2 分で観察を打ち切ると **8 回目**までしか見えず」は厳密には 7 回目（121 秒の 8 回目は 120 秒の直後）。結論（2 分では足りない / 4 分が妥当）は変わらないので修正不要。
- **[N-003]** 実機計測サマリ（すべて `--host 127.0.0.1 --no-open`、SSE 接続 1 本を張った状態）
  - ディレクトリモード / Node 22.22.1: SIGINT → `exit=0 elapsed=41ms`、警告なし
  - HTML ファイルモード / Node 22.22.1: SIGINT → `exit=0 elapsed=39ms`、警告なし
  - ディレクトリモード / Node 24.18.0: SIGINT → 約 39ms で終了、警告なし
  - 実 TTY（pty 割当）: SIGINT → 約 100ms 以内に終了、clack 枠・空行とも正常
  - SIGTERM: `exit=0 elapsed=40ms`、`Received SIGTERM` を出力
  - `--port` 衝突: 2 つ目が `exit=1` / `Port <n> is already in use`、1 つ目は生存
  - 2 回連続 SIGINT（正常系）: `exit=0`、`Force exiting...` は出ない
  - **フォールト注入（`server.close()` のコールバックを永久に呼ばない版）**: 1 回 SIGINT → `exit=0 elapsed=2089ms` + `[peek] HTTP server did not close within 2000ms — ...`／2 回 SIGINT → `exit=1 elapsed=273ms` + `Force exiting...`
- **[N-004]** 本レビューの破壊的検証は隔離 worktree（`scratchpad/wt-req-r4`、detached HEAD `3aff692`）の `dist/` に別名コピーしたバンドルに対してのみ行い、検証後に削除して `git status --porcelain` が空であることを確認した。起動した子プロセス（peek / curl / script / nix 経由の node）はすべて回収し、レビュー終了時点で `pgrep` による残存ゼロを確認済み。worktree もレビュー終了時に `git worktree remove` で撤去した。メインの作業ツリーには本ファイル以外の変更を加えていない。
