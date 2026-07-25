# 実装計画 — Issue #102: Ctrl+C でシャットダウンが無限ハングすることがある（SSE 再接続のレースで server.close() が解決しない）

**Issue:** #102
**作成日:** 2026-07-25
**複雑度:** 中〜大規模

---

## 目的

`Ctrl+C`（SIGINT）を 1 回押したら、SSE 接続中のブラウザタブが開いていても **必ず有限時間で peek プロセスが終了する** ようにする。あわせて、シャットダウン手順を「たまたま同期実行だから安全」ではなく「構造として新規接続が入り込めない」状態にする。

**要件と再発防止の主従関係（本計画の前提）**

- Issue から読み取れる要件は「Ctrl+C 1 回で peek プロセスが有限時間で終了すること」の **1 つだけ**。修正案 1〜3 は「いずれか」と明記された手段の候補であって要件ではない。
- 後述「調査結果」のとおり、**Issue 本文に書かれたレースのシナリオは現行コードでは成立せず、真因は特定できていない**。
- したがって **有界シャットダウン（タイムアウト）が要件充足の唯一の保証**であり、構造対策（順序変更・シャットダウン中フラグ）は再発防止・堅牢化として従の位置づけになる。この主従を曖昧にしない。

## 受け入れ基準

| # | 基準（検証可能な形で） | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | **SSE 接続が張られた状態の peek プロセスに SIGINT を 1 回送ると、5 秒以内に exit code 0 で終了する**（`shutdown()` が resolve でも reject でも成立すること） | Issue 本文（唯一の要件） | 1, 3, 4 |
| AC-2 | `shutdown()` は `server.close()` が永久に解決しない場合でも必ず有限時間で settle する（上限 = `SHUTDOWN_TIMEOUT_MS`(2000ms) + 実行オーバーヘッド）。**間接検証**（`withTimeout` 単体テスト + `shutdown()` の唯一の待機点がそれを使うというコード上の構成）であり、`shutdown()` 自体に「永久に解決しない close」を注入するテストは存在しない | Issue 修正案 2 | 1, 2, 3 |
| AC-3 | `startServer(config, { shutdownTimeoutMs: 0 })` で起動したサーバーの `shutdown()` は**決定的にタイムアウト分岐を踏み**、`logger.warn` で「期限内に close しなかった」旨が出力される。かつ既定タイムアウト（2000ms）下では SSE 接続中にシャットダウンしても**警告が出ない**（偽陽性が無い） | 本計画の調査結果 | 1, 2, 3, 4 |
| AC-4 | `shutdown()` の呼び出しから戻った直後（最初の `await` の前）にはリスナーが閉じており、新規 TCP 接続が受け付けられない | 再発防止（Issue 修正案 1） | 3, 4 |
| AC-5 | シャットダウン開始後に届いた `/sse` リクエストは **SSE ストリームを一切開始せず 503 を返す**（`sse.app.request("/sse")` の `status` と `content-type` で検証） | 再発防止（Issue 修正案 1） | 6, 7 |
| AC-6 | シャットダウン開始後に `/sse` を叩いても `clientCount` が 0 のまま増えない | 再発防止（Issue 修正案 1） | 6, 7 |
| AC-7 | 接続済み SSE レスポンスの body が、`sse.shutdown()` 後に **keep-alive 間隔（30 秒）を待たずに EOF に達する**（`sse.app.request("/sse")` のレスポンス body を `getReader().read()` で読み、500ms 以内に `done: true`） | 回帰防止（既存の per-client abort の維持） | 6, 7 |
| AC-8 | **SSE client 1 本あたりの `abort` リスナーが keep-alive の周回で増えない。** `createSseManager()` の `/sse` ハンドラを vitest の fake timers で駆動し、**レスポンス body をバックグラウンドで読み捨ててループを実際に回した上で**、client の `AbortSignal` に載る `abort` リスナー数が **1 以下**であることで検証する。**positive control を必ず伴う**（`sse.clientCount === 1` かつ 観測したリスナー数の中に `1` が実在すること）— これが無いと「ハンドラが keep-alive 待機に到達しない実装」でも `counts=[0,0]` → `max=0` で緑になる（vacuous pass） | アーキレビューで実測された欠陥 | 6, 7 |
| AC-9 | 既存のシャットダウン関連テスト（冪等・並行呼び出し・シャットダウン後の接続拒否・SSE ライフサイクル）が引き続き通る | 回帰防止 | 4, 7, 8 |
| AC-10 | 手動確認（非退行 + 観測）: `peek . --host 0.0.0.0 --port 3009` をブラウザタブ常時オープンで起動し Ctrl+C を 10 回試行して、(a) 毎回 5 秒以内に `Server stopped. Bye!` が出て終了する、(b) `Shutting down...` / `Received SIGINT, ...` の表示有無を記録する、(c) タイムアウト警告の有無を記録する | Issue 再現条件 | 5, 9 |
| AC-11 | **シャットダウン手順 2 / 3 / 4 のいずれが throw しても、後続の手順と手順 5 の有界待機は実行され、失敗は 1 件ならそのまま / 2 件以上は `AggregateError` で呼び出し側に届く**（`serve()` / `SseManager.shutdown()` / `createFileWatcher()` をスタブして各手順に throw を注入し、`calls` の並び・経過時間・警告回数・throw された値で検証する） | 実装レビュー 2〜3 ラウンド目（エラー分離の回帰ガード） | 3, 4 |

**この計画は実装レビューを受けて更新してある**（末尾「レビュー履歴 / 実装レビュー」参照）。設計判断そのものの最新の正は `adr.md` であり、本文と食い違いが見つかった場合は `adr.md` を優先する。

**AC-10 の限界（明記事項）**: 元の事象は Issue 本文にあるとおり「普段は正常に終了する」低頻度のタイミング依存事象である。母数不明の稀事象に対して n=10 の成功は「直った」ことの証明にならない（真の発生率が 1% なら 10 回連続成功の確率は 90%）。**終了性の保証は AC-1 / AC-2 が担い、AC-10 の役割は (i) 正常系の非退行確認と (ii) 真因切り分けのための観測記録に限られる。**

**AC-1 / AC-10 の閾値について**: `SHUTDOWN_TIMEOUT_MS = 2_000` なので、タイムアウトが設計どおり発火した正常なケースでも終了は「2 秒 + `outro()` + `process.exit`」で 2 秒を必ず超える。閾値 5 秒は「タイムアウト値 2 秒 + 実行オーバーヘッドの上限」として定義したもので、タイムアウト値と整合している。実測では現行コードでも SIGINT から `close` まで 7〜73ms（後述「調査結果」）なので、マージンは十分大きい。

**AC-8 が証明する範囲（明記事項）**: このテストは「client 1 本あたりの `abort` リスナーが keep-alive の周回で 1 個を超えない」ことを検証する。**3 周目でレスポンス body の読み捨てと positive control を追加した最終形**を、4 実装 × body 読み捨ての有無 × 8 tick で実測した（本計画）:

| 実装 | body を読まない | **body を読み捨てる（最終形）** |
|---|---|---|
| (a) `node:timers/promises` 版（本計画の実装） | `[1,1,1,1,1,1,1,1]` | `[1,1,1,1,1,1,1,1]` → **pass** |
| (b) 手書き `sleep()`（リークあり） | `[2,2,2,2,2,2,2,2]` | **`[2,3,4,5,6,7,8,9]`** → **fail** |
| (c) ハンドラが keep-alive 待機に到達しない | `[0,0,0,0,0,0,0,0]` | `[0,0,0,0,0,0,0,0]`（`clientCount = 0`）→ **fail**（positive control が捕捉） |
| (d) 手書きだがリーク修正済み（fake timers に駆動される） | `[1,0,0,0,0,0,0,0]` | `[1,1,1,1,1,1,1,1]` → pass |

body を読み捨てることで得られる差は 2 つある。

1. **判別マージンが 1 → 8 に広がる**（8 tick の場合。計画のスケッチは 5 tick なので 1 → 6。本計画で最終形を 5 tick で実測: (a) `[1,1,1,1,1]` pass / (b) `[2,3,4,5,6]` fail / (c) `[0,0,0,0,0]` fail）。body を読まない形は Hono の `TransformStream` が書き込みを 1 件だけバッファする挙動に依存しており、Hono 側が変わると手書き `sleep()` でも `[1,1,...]` になって false-green になりうる。
2. **fake timers の非対称性への依存が外れる。** 上表 (d) のとおり、**fake timers に駆動される正しい実装でも `[1,1,...]` で通る**。したがってこのテストが見ているのは「実装がグローバル `setTimeout` か `node:timers/promises` か」ではなく「**client 1 本あたりの abort リスナーが 1 個を超えないか**」という性質そのものである。将来 vitest が `node:timers/promises` を駆動するようになっても false-red にならない。

**それでも残る限界**: (a) は `node:timers/promises` が fake timers に駆動されないため、ループは最初の待機で止まったまま `[1,1,...]` になる。つまり **(a) について「N 回正常完了してもリークしない」ことを実行時に確認しているわけではない**（落ちる方向の判別性はある。上表 (b)）。この性質そのものは ADR-006 に記録した直接実測（手書き 25 個 / 標準 API 0 個、本計画で再現）で担保する。

## スコープ

### 含まれるもの（付随整理 — 要件充足には不要だが本 Issue に含める）

- **`in` ナローイングの扱い（ADR-004）** — ステップ 3 で `shutdown()` 本体をまるごと書き換える際に当該行（`if ("closeAllConnections" in server)`）を必ず触る。当初は型述語 `isHttpServer` への集約を予定していたが、**実装レビューで撤回した**（型述語は本体と述語の整合をコンパイラが検証しないため、検証済みナローイングからの後退になる）。**`in` のまま残し、なぜナローイングが必要かのコメントだけを添える。** **受け入れ基準には含めない**（`in` のままでも `pnpm typecheck` は通るため、変更前後で常に真になる条件しか書けない）。
- **`ServerInstance` から `sseCloseAll` / `close` / `watcher` を削除（ADR-005）** — `sseCloseAll` の削除は `closeAll` → 終端 `shutdown` 改名（ADR-003）の必然的帰結。`close` の削除は「未使用**かつ**誤用で本 Issue のハングを再現できる」経路の除去。`watcher` は当初「残す」判断だったが、**実装レビューで削除に反転した**（`server.watcher.close()` 単独呼び出しで「HTTP と SSE は生きたまま監視だけ死ぬ」不整合を外部から作れるため、削除基準の後半を満たす）。結果として `ServerInstance` は `{ shutdown }` の 1 メソッド型になる。AC は足さない（AC-9 の既存テスト通過でカバーされる）。
- **keep-alive の `sleep()` の abort リスナーリーク修正（ADR-006）** — 本 Issue の調査で実測できた唯一の欠陥（25 回の正常 sleep 後にリスナー 25 個）。変更対象そのものである keep-alive ループ内にあり、「ブラウザタブを長く開いているほど踏みやすい」という Issue の症状プロファイルと一致する唯一の実測欠陥のため、本 Issue のスコープに含める（AC-8 で回帰ガード）。
- **CLI のシグナル受信ログ（ADR-007）** — 1 行。真因未特定を前提に、次回再発時の切り分け手段を残す。

### 含まれないもの

- **`process.exit(0)` 前の stdio drain** — 1 周目に改善提案として計画に入れたが、**2 周目で削除した**。理由は 2 つ。(1) 要件充足に寄与しない観測性強化であるにもかかわらず、パイプの読み手が既に死んでいる状態では uncaught EPIPE を招き **exit code を 0 から 1 に変える**（本計画で実測: drain 無し → exit 0 / drain 有り → exit 1）。AC-1 を直接壊す。しかも壊れるのは `peek . 2>&1 | tee log` のように **AC-3 の警告を採取しようとした手順そのもの**（Ctrl+C はフォアグラウンドプロセスグループ全体に届き `tee` が先に死ぬ）。(2) そもそも救う場面がほぼ無い。1 行の短い書き込みは pipe 越しでも `process.exit(0)` の直前に書けば欠落しないことを実測した（欠落するのは未 flush 出力が 64KB を超える場合のみ）。→ 詳細は ADR-007、残存リスクは「リスクと注意点」に記載。
- **タイムアウト打ち切り時の再 `closeAllConnections()`** — 1 周目に入れたが、**2 周目で削除した**。手順 1 でリスニングハンドルを閉じているため手順 4 以降に新規ソケットが accept されることはなく、手順 4 で destroy 済みのソケットへの再 destroy は no-op である。「効く場面が構成上存在しない」ものを「保険」として残すと将来の読者を誤らせる（ADR-007）。
- **クライアント側 SSE 再接続ロジックの変更** — 対象は 2 つある: `src/client/lib/sse.ts`（Preact 側）と `src/server/renderer/html-document.tsx` のインラインスクリプト（HTML ファイルプレビュー用）。どちらも `EventSource` の組み込み再接続に依存せず、`onerror` で `close()` してから自前で `setTimeout(connect, delay)` する独立実装である。「サーバーがシャットダウン中なら再接続しない」ようなクライアント側の抑制は、サーバーが死んだ後に届く保証がなく本質的に信頼できない。サーバー側でリスナーを閉じれば再接続は TCP レベルで失敗し、既存の指数バックオフ + 10 回上限で自然に収束する。
- **graceful drain（進行中リクエストの完走待ち）** — peek は読み取り専用のプレビューサーバーで、中断による副作用（データ欠損等）が無い。中断は許容し、速やかな終了を優先する。
- **keep-alive 間隔（30 秒）の見直し／`createSseManager()` への間隔注入口** — シャットダウン応答性は per-client abort 経由で確保されており（AC-7 で検証）、間隔の変更は不要。テスト都合で注入口を開けるのは本 Issue の要件と無関係な API 拡張なので採らない。
- **`process.exit` の呼び出し箇所の再設計** — `process.exit` は現状どおり CLI 層（`src/index.ts`）にのみ置く。サーバー層には持ち込まない（ADR-001）。
- **`--host 0.0.0.0` 固有の挙動（LAN 上の他クライアント）への対応** — 本 Issue の症状はブラウザタブ 1 つで再現しており、複数クライアントは症状の増幅要因に過ぎない。

## 調査結果

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/server/index.ts` | `startServer` / `ServerInstance` / `shutdown()`。今回の変更の中心 |
| `src/server/routes/sse.ts` | `createSseManager`。`clients: Set<SSEClient>`、`closeAll()`、keep-alive ループ、手書きの `sleep()` |
| `src/index.ts` | CLI エントリ。SIGINT/SIGTERM ハンドラ、2 回目シグナルでの force exit、`process.exit(0)` |
| `src/client/lib/sse.ts` | **SSE クライアント実装 その 1**（Preact 側）。`onerror` で `evtSource.close()` → 自前 `setTimeout(connect, delay)`。初期 1s・指数バックオフ・上限 30s・最大 10 回・5 秒安定でリトライ数リセット |
| `src/server/renderer/html-document.tsx` | **SSE クライアント実装 その 2**（HTML ファイルモードのインラインスクリプト、`sseReloadScript`）。`src/client/lib/sse.ts` と同等の独自リトライを持つ独立実装。**Issue 本文が引用している `var es = new EventSource("/sse");` はこちらのコード**（`src/client/lib/sse.ts` は `const evtSource`）。`src/server/index.test.ts` が使う `contentType: "html"` はこの実装が載るモード |
| `src/client/hooks/use-sse-updates.ts` | `createSseConnection` の呼び出しと cleanup |
| `src/core/sse-constants.ts` | クライアント/サーバー共有の SSE 定数（リトライ関連のみ）。上記 2 実装の双方が参照 |
| `src/lib/watcher.ts` | `FileWatcherHandle`。`close()` は同期・冪等で問題なし |
| `src/lib/logger.ts` | `[peek]` プレフィックス付き console ラッパー（`info`/`warn`/`error`）。**クライアント（`src/client/lib/sse.ts:7`）からも import されている** |
| `src/core/result.ts` / `src/core/error.ts` | `Result<T, E>` / `TypedError<T, P>`（`cause: Error` 必須） |
| `src/server/index.test.ts` | シャットダウンのライフサイクルテスト（実ポートで `startServer` → `fetch` → `shutdown`）。`getFreePort()` を内包 |
| `src/server/routes/sse.test.ts` | `sse.app.request("/sse")`（Hono の直接 request）を使った SSE マネージャ単体テスト |
| `.github/workflows/ci.yml` | PR ごとに `ubuntu-latest` × **Node 22 / 24** の matrix で `pnpm lint` / `format:check` / `typecheck` / **`pnpm test`** / `build` を実行する |

### あるべきアーキテクチャ

このリポジトリに `spec/` は無い。規約の情報源は CLAUDE.md（型安全性の最大活用 / ステートレスな純粋関数型スタイル）と既存の `src/` レイヤー構成。

- `src/core/` — **フレームワーク/ランタイム非依存**の純粋ロジック・型・定数（`.issue/89/adr.md` ADR-001 がこの区分を明文化している）。
- `src/lib/` — **ランタイム（Node）依存**のユーティリティ（`watcher`、`markdown`、`project-id`、`logger` 等）。**「サーバー専用」という意味ではない**: `src/lib/logger.ts` は `src/client/lib/sse.ts` から import されており、実際にクライアントバンドルに入っている。
- `src/server/` — Hono アプリ、ルート、レンダラ、プロセス外の資源（HTTP サーバー / watcher）のライフサイクル管理。
- `src/client/`, `src/components/` — Preact 側。
- `src/index.ts` — CLI 層。**プロセス制御（`process.exit`）はここだけの責務**。実際に現状も `process.exit` は `src/index.ts` にのみ存在する。
- 状態を持つものは `createXxx()` がクロージャで閉じ込め、`readonly` なメソッド群を持つハンドル型（`FileWatcherHandle`、`SseManager`、`ServerInstance`）を返す。この形は本 Issue でも踏襲する。
- 型安全性: `Result<T, E>` / `TypedError` / 判別可能なユニオン（`ServerConfig`、`AppContext`）が徹底されている。`"closeAllConnections" in server` はこの方針から外れた数少ない箇所。

### 既存実装の状態

**あるべき姿と一致している箇所（尊重して踏襲する）**

- `shutdown()` の memo 化による冪等性（`shutdownPromise`）。既存テストが担保済み。
- watcher / SSE / HTTP サーバーをハンドル型で扱う構造。
- keep-alive ループの停止に per-client の `AbortController` を使っている点（同期的にループを起こせる正しい設計）。

**乖離している箇所**

1. **`if ("closeAllConnections" in server)`（`src/server/index.ts:196`）** — `serve()` の戻り値型は `ServerType = http.Server | Http2Server | Http2SecureServer`（`node_modules/@hono/node-server/dist/types.d.ts`）。`closeAllConnections()` / `closeIdleConnections()` は `@types/node` の `http.d.ts` にしか定義が無く（`http.d.ts:463,469`）、`Http2Server` には存在しないため union のままでは呼べない。現状はインラインの `in` ナローイングで回避している。当初はこれを「型安全方針から外れた箇所」と見て型述語化を予定したが、**実装レビューでその見立て自体が誤りだったと判明し撤回した** — `in` はコンパイラが検証するナローイングであり、手書きの型述語（本体と述語の整合は検証されない）に置き換えるのは型安全性の後退になる。**乖離ではなかったので変更しない**（→ ステップ 8 / ADR-004）。
2. **`ServerInstance` が「部分シャットダウン」API（`close` / `sseCloseAll` / `watcher`）を公開している** — `grep` の結果、いずれも `src/` 内のどこからも呼ばれていない（`close` / `sseCloseAll` は `shutdown()` の内部でのみ使用、`watcher` は宣言行のみ）。package.json には `main` / `exports` が無く `bin` のみなので、これらはライブラリ API ですらない。`close()` だけを呼ぶと「SSE ストリームが生きたまま `server.close()` が待ち続ける」= 今回直そうとしているハングそのものを再現でき、`watcher.close()` だけを呼ぶと「HTTP と SSE は生きたまま監視だけ死ぬ」不整合を作れる（→ ステップ 8 / ADR-005）。
3. **`closeAll()` の名前と役割** — 呼び出し箇所（listen エラー時 / shutdown 時）はいずれも「二度と使わない」終端操作であり、非終端の `closeAll` という用途は存在しない（→ ステップ 6 / ADR-003）。
4. **`sleep()`（`src/server/routes/sse.ts:9-21`）が正常完了のたびに abort リスナーをリークする** — `{ once: true }` は「発火したら外す」であって「解決したら外す」ではない。**本計画で再度実測し、25 回の正常 sleep 後にリスナー 25 個**が `AbortSignal` に残ることを確認した（`node:events` の `getEventListeners`。`node:timers/promises` 版は 0 個）。keep-alive は 30 秒周期なので SSE クライアント 1 本あたり毎時 120 個のリスナー + クロージャが蓄積する（→ ステップ 6 / ADR-006）。

### Issue の推定原因に対する検証結果（重要）

**Issue 本文に書かれたレースのシナリオは、現行コードでは成立しない。** 2 名のレビュアーが独立に検証して一致した。根拠:

- `shutdown()` の本体は async IIFE だが、`sseCloseAll()` → `watcher.close()` → `closeAllConnections()` → `close()`（`server.close(cb)` の呼び出し自体）まで **`await` が 1 つも無い**。`close()` の中の Promise executor は同期実行されるため、`server.close()` はシャットダウン開始と同じ同期ターンで呼ばれ、`net.Server.prototype.close` はその場でリスニングハンドルを閉じる。
- JavaScript は単一スレッドで、**マイクロタスクは次のマクロタスクの前に必ず全て流れる**。SIGINT ハンドラも `connection` / `request` イベントもマクロタスクであり、互いに interleave できない。
- SSE クライアントの登録も同期的である。Hono の `streamSSE` は `run(stream, cb, onError)` を `await` せずに呼び、`cb` は最初の `await`（keep-alive の `sleep`）まで同期実行される。したがって `clients.add(client)` はハンドラ起動と同一マイクロタスクチェーン内で完了する（`node_modules/hono/dist/helper/streaming/sse.js` を確認済み）。

→ **「`closeAll()` の後に `clients` へ追加される client」は現行コードでは発生しない。**

**真因は特定できていない。** アーキ視点のレビュアーが Node 22.22.1 / macOS 上で以下を実施したが、**一度も再現しなかった**:

| 実験 | 結果 |
|---|---|
| `startServer()` を使った実シナリオ 8 種（SSE / 即時再接続 / アイドル keep-alive / 無言ソケット等） | すべて 0〜3ms で resolve |
| 40 本の SSE 接続を 1ms 間隔で切断→即再接続させる接続ストーム下でのシャットダウン | `closeAllConnections()` 直後に `_connections` が**同期的に 0**、`server.close()` は 3ms で resolve |
| 送信バックプレッシャー下（ピアが読まない状態で 64KB を書き続ける）でのシャットダウン | 3ms で resolve、ストリームコールバックも 3/3 が返る |
| 実 CLI に実 SIGINT を送る E2E を 12 回 | ハング 0/12、最大 64ms、全て exit code 0 |

**本計画でも現行コードのまま実 CLI に実 SIGINT を送って追試した**（SSE 接続を張った状態、Node 22.22.1 / macOS）: `tsx` バイナリ経由で起動 496ms・SIGINT から `close` まで 73ms・exit code 0、`node --import ./src/loaders/css.mjs --import tsx/esm` 経由で 319ms・7ms・exit code 0。**ハングは再現しない。**

→ 「`closeAllConnections()` が取りこぼす」系の候補はほぼ潰せた。**残る有力な変数は Node のバージョン差（報告者 v24.15.0 / 検証 v22.22.1）**、次点で **SIGINT ハンドラ自体が起動していなかった可能性**。Issue の「SIGTERM で即座に終了した」という観測は、(i) SIGINT ハンドラが `await server.shutdown()` で停止 → SIGTERM が force exit 分岐（`process.exit(1)`）に落ちた、と (ii) SIGINT ハンドラがそもそも起動していなかった → SIGTERM で初めて正常終了した、の**両方と整合する**。(ii) を排除する証拠は無い（→ ステップ 5 / ステップ 9 で切り分けの観測手段を用意する）。

なお **Node 22 / 24 の差は CI で部分的に自動追跡される**。`.github/workflows/ci.yml` の matrix は `ubuntu-latest` × `node-version: [22, 24]` で `pnpm test` を回すため、ステップ 4 で追加するプロセスレベルの終了性テスト（AC-1）は **Node 24 上でも自動実行される**。残るのは OS 差（Linux / macOS）と実ブラウザの有無だけなので、ステップ 9 の Node 24 手動確認はその 2 点に限定してよい。

この結論が設計方針を決める:

- **原因が未特定である以上、「レースを塞ぐ」だけでは AC-1（必ず終了する）を保証できない。** 有界シャットダウン（タイムアウト）が AC-1 / AC-2 の唯一の保証手段になる。
- 一方で、現行の安全性は「たまたま `await` が無い」ことに依存している。誰もその制約をコメントにも型にも書いていないため、将来 `await` が 1 つ入れば Issue 記載のレースが**本当に**発生する。**構造的にレースが起き得ない形に作り替える価値は独立して存在する（ただし従）。**

→ 二層構成にする（ADR-001）。詳細は「設計判断」。

### 依存関係

- `src/index.ts` の SIGINT/SIGTERM ハンドラ → `ServerInstance.shutdown()`（唯一の外部呼び出し）。
- `src/server/index.test.ts` / `src/server/routes/sse.test.ts` は `shutdown` / `closeAll` を直接叩くため、シグネチャ変更の影響を受ける。
- クライアント側は**コード変更不要**。シャットダウン開始後の `/sse` は 503 を受け取るようになるが、**2 つのクライアント実装はいずれも `onerror` で自前リトライするため観測される挙動は 200 + 即クローズの場合と同一**（`onerror` 発火 → `close()` → 自前の `setTimeout(connect, delay)`、最大 10 回で収束）。そして `server.close()` をシャットダウン冒頭で呼ぶため、**そのリトライ試行はそもそも TCP レベルで失敗する**（`ERR_CONNECTION_REFUSED`）。native `EventSource` の「非 2xx は恒久 CLOSED」仕様は、`onerror` が独自に再接続する以上この実装には効かない。

## 設計

### ドメインモデルへの影響

なし。peek にドメイン層は存在せず、本 Issue はプロセス/リソースのライフサイクル管理に閉じる。

### ライフサイクル管理（レイヤー内側 = `src/lib/`）

新規に「Promise を有界時間で打ち切る」ユーティリティを 1 つ導入する。

```ts
// src/lib/with-timeout.ts
export type TimeoutOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "timed-out" };

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimeoutOutcome<T>>;
```

設計上のポイント:

- **判別可能なユニオンで返す。** `Result<T, E>` は使わない — `Result` は「成否」を表す語彙だが、タイムアウトは失敗ではなく期待される分岐だから。加えてリポジトリ内の `Result` の `E` は実際すべて `TypedError` 派生であり、そこに載せる自然なエラーがない（ADR-001 補足）。
- **予算ゼロの判定は `timeoutMs <= 0` ではなく `!(timeoutMs > 0)` と書く。** `NaN` は `NaN <= 0` が **false** になるため前者では `setTimeout(NaN)` 経路（実測: 約 3ms 後に発火）に落ちて意味論が曖昧になるが、`!(NaN > 0)` は **true** なので後者なら `NaN` も「予算ゼロ」に落ちる（本計画で実測確認）。呼び出し元は `shutdown()` の 1 箇所だけなので実害は無いが、型で防げない入力に対する全関数化として後者が素直（CLAUDE.md の型安全性志向とも整合）。
- **予算ゼロ（`!(timeoutMs > 0)`）のときは「常にタイムアウト」として、`promise` の settle 順序と無関係に決定的に `{ status: "timed-out" }` を返す。** これにより予算ゼロで起動したサーバー（`startServer(config, { shutdownTimeoutMs: 0 })`）の `shutdown()` が決定的にタイムアウト分岐を踏み、AC-3 が自動テスト可能になる。素朴に `setTimeout(0)` と race させる実装ではこれができない（`server.close()` のコールバックは `setTimeout(0)` より必ず先に流れる）。**本計画で実測: この版は実 `server.close()` を相手にして 10/10、`process.nextTick` 解決の Promise を相手にして 20/20 で `timed-out` を返した。**（実装としては executor 内で同期的に resolve する／`Promise.resolve(...)` を早期 return するが、**「同期的に resolve する」という表現は呼び出し側の観測とずれるので契約の記述には使わない** — `await` への配送は必ずマイクロタスク経由なので、呼び出し側から見れば `withTimeout(p, 0)` も `withTimeout(p, 2000)` も等しく非同期である。「同期 resolve」は実装メモとしてのみ併記する。）
- **`promise` の reject を透過させるのは「予算内に reject した場合」だけである（実装レビューで記述を精密化）。** 予算内 reject はそのまま reject として透過し、`server.close()` のエラーが `shutdown()` の reject → CLI の `catch` → `logger.error` に流れる既存挙動を維持する。一方**予算超過後の reject と予算ゼロ経路の reject は、購読はするが破棄される**（outer promise が既に settle 済みのため、どこにもログが残らない）。`TimeoutOutcome<T>` を `{ status: "failed" }` の 3 分岐にすればこの経路も表現できるが、`close()` の memo 化により到達可能性が極めて低いため、実装は変えず doc の記述を事実に合わせる（ADR-001）。
- **`Promise.race` 相当の購読をすること。** タイムアウト後に `promise` が reject しても、reject ハンドラが既に接続済みなので unhandled rejection にならない。予算ゼロの早期 return 経路でも `promise.catch(() => {})` を必ず張る。
- **タイマーは決着時に `clearTimeout` する。`unref()` は呼ばない（3 周目で方針変更）。** 詳細と実測は下記「`unref()` を採用しない理由」。
- **配置は `src/lib/`。ただし「どちらでも壊れない」ことが結論である（配置根拠は実装レビューで 2 度書き直した。ADR-001 を参照）。** 採用しなかった根拠を 2 つ記録しておく: (i)「タイマーという副作用をスケジュールするから」— 分割として成立しない（`src/lib/node-error.ts` / `markdown.ts` は副作用を持たず、既存の明文化された基準は `.issue/89/adr.md` ADR-001 の「`src/core/` はランタイム非依存層」である）。(ii)「`src/core/` はクライアントバンドルに入りうるから」— **事実として誤り**（`scripts/build-client.mjs` は `entryPoints: ["src/client/entry.tsx"]` + `bundle: true` なので、載るのはエントリから到達可能なモジュールだけ。ディレクトリ所属は無関係で、生成物を検査しても `src/core/` の未使用モジュールは 1 つも含まれていない）。残るのは中身から読み取れる事実上の区分だけで、`src/core/` は peek のドメイン語彙、`src/lib/` は基盤ヘルパである。`withTimeout` は後者なので `src/lib/` に置くが、それ以上の意味は持たない。**したがって配置根拠を実装の doc コメントに書かず、ADR への参照 1 行だけを残す。**

**`unref()` を採用しない理由（3 周目・実測に基づく方針変更）**

2 周目までの計画は「タイマーを `unref()` する。unref しないとタイムアウト時間だけイベントループが生き延び、テストの teardown が遅延する」としていた。本計画で 4 パターンを実測した結果、**この理由は成立せず、逆に `unref()` は AC-3 の観測性を失う経路を持つ**ことが確認できたので、`unref()` を採用しない。

| ケース（タイムアウト 300ms） | 結果 |
|---|---|
| `unref()` あり・`promise` が未解決・他に ref 付きハンドルが無い | **1ms でプロセスが自然終了。警告も `outro()` も `process.exit(0)` も走らない**（exit code 0） |
| `unref()` なし・`promise` が未解決・他に ref 付きハンドルが無い | 306ms でタイムアウト発火 → 警告出力 → 正常終了（exit code 0） |
| `unref()` あり・`promise` が未解決・ref 付きハンドルあり（= 本 Issue の症状） | 306ms でタイムアウト発火 → 警告出力（unref でも害は出ない） |
| `unref()` なし・`promise` が 10ms で解決 | **14ms でプロセス終了**（`clearTimeout` により teardown は一切遅延しない） |
| `unref()` なし・`clearTimeout` を落とした場合 | completed 後も **303ms** 生き残る（= teardown 遅延を防いでいるのは `clearTimeout` であって `unref()` ではない） |

- 「teardown が遅延する」という 2 周目の理由は **偽**である。`promise` が settle した時点で必ず `clearTimeout` するため、ref 付きのままでもタイマーが待機を延ばすことはない（4 行目の実測）。`withTimeout` の全経路（予算ゼロの早期 return / 期限内 settle / タイムアウト発火）のいずれにおいてもタイマーは「張られない」「クリアされる」「発火して消費される」のどれかであり、生き残る経路が存在しない。**したがって `unref()` を外してもテストの teardown への影響は無い。**
- 一方 `unref()` には実害がある（1 行目）。「`server.close()` のコールバックが来ないが ref 付きハンドルも残っていない」という状況では、unref 済みタイマーは発火せず、**ADR-001 が「真因切り分けの唯一の手掛かり」と位置づけた `logger.warn` ごとシャットダウンの終盤が丸ごとスキップされる**。本 Issue の症状（ハング）では ref 付きハンドルが残っているので実際には発火する（3 行目）が、要件（AC-1: 必ず有限時間で終了する）と観測性（AC-3）の両方を守る側に倒すなら ref のままが素直である。
- 結論: **`unref()` は呼ばない。** この判断理由を実装時に doc コメントへ 1 行残す。

### SSE マネージャ（`src/server/routes/sse.ts`）

`SseManager` に終端状態を導入する。

```ts
export type SseManager = {
  readonly app: Hono;
  readonly broadcast: (event: string, data: string) => void;
  readonly shutdown: () => void;   // closeAll から改名・終端化
  readonly clientCount: number;
};
```

`shutdown()` の実装契約（順序が本質）:

1. `shuttingDown = true` を**先に**立てる。
2. その**後で** `clients` を走査して各 client を `close()`（= `cleanup()` = `abortController.abort()` + `clients.delete`）。
3. `clients.clear()`。

`/sse` ハンドラ側は 2 段構えでチェックする。

```
app.get("/sse", (c) => {
  if (shuttingDown) return c.body(null, 503);     // ① 早期拒否（ストリームを一切作らない）
  return streamSSE(c, async (stream) => {
    ...
    stream.onAbort(cleanup);                      // 購読を先に張る
    if (!closed) clients.add(client);             // 死んだ client を登録しない
    if (shuttingDown) { cleanup(); return; }      // ② 登録直後の再チェック
    while (!closed) { ... }
  });
});
```

**`onAbort` の登録は `clients.add` より前・client を組み立てた直後に置き、`add` は `!closed` でガードする（実装レビューで改訂）。** 当初の計画は `clients.add` → `onAbort` の順で、「順序を入れ替えれば窓は消える」としていたが事実ではなかった。フォールト注入（2 つの間に人工的な `await` を挟み、その窓で abort させる）で実測した結果:

| 実装 | 窓の中で abort したときの `clientCount` |
|---|---|
| `add` → `onAbort` | **1**（`closed` が false のままで keep-alive も回り続ける） |
| `onAbort` → `add`（順序変更のみ） | **1**（`cleanup()` の `clients.delete` が空振りし、その後 `add` が死んだ client を登録する） |
| `onAbort` → `if (!closed) add`（採用形） | **0** |

Hono の `StreamingApi.abort()` は `aborted` をラッチしたうえで**その時点で登録済みのリスナーにしか通知しない**ため、「`onAbort` を先に登録する」が `cleanup()` の到達を保証し、「`!closed` ガード」が死んだ client の登録を防ぐ。**2 つで 1 組**である（ADR-003）。なお `onAbort` の登録**より前**に `await` が入った場合は塞げない — 不変条件「`onAbort` の登録は client を組み立てた直後・他の何よりも先」はコードの並びで守るしかなく、コメントに残す。

**なぜこれでレースが構造的に閉じるか**（「フラグを公開してから走査、自分を公開してからフラグを再チェック」パターン）:

- ハンドラ側の `clients.add` → ② のチェックには `await` が無く 1 同期ブロック。`shutdown()` 側の「フラグ立て → 走査」も 1 同期ブロック。**単一スレッドでは、マイクロタスクは次のマクロタスクの前に必ず全て流れる**ため、`request` イベント由来のブロックと SIGINT ハンドラ由来のブロックが interleave することはない。
- ハンドラブロックが先 → client は `clients` にいるので走査で閉じられる。
- `shutdown()` ブロックが先 → ② が `true` を読んで即 `cleanup()` して return する。
- どちらの順でも取りこぼしが無い。**この保証は Hono の実装詳細（`run` が同期呼び出しであること、`/sse` が単一ハンドラマッチの fast path に入ること）に依存しない。** 将来 `app.use(...)` が増えて `compose` 経路（マイクロタスク境界を跨ぐ）に落ちても、`shutdown()` に `await` が入っても、上記の議論は成立し続ける。

**②に落ちた場合のワイヤ上の帰結**: `streamSSE` は `c.newResponse(stream.responseReadable)` を返してからストリームを閉じるため、②で `cleanup(); return;` すると **HTTP 200 + `text/event-stream` + 即 EOF** が返る。①の 503 とは挙動が異なる。窓は「2 つの同期ブロックの順序が逆転したとき」だけで、1 回のシャットダウンにつき最大 1 接続。クライアントは `onerror` → 自前リトライ → TCP 拒否で収束するため実害は無い。**①の 503 は「意味論的に正しいステータスを in-flight リクエストに明示的に返す」ための設計であり、②は「取りこぼさない」ための正しさの保証**という役割分担になっている。

**既に走っている keep-alive ループをどう確実に止めるか** — フラグは新規接続を止めるだけで、走行中のループは止めない。停止は **2 層**で担保する:

1. **主**: per-client の `abortController.abort()`（`shutdown()` の走査が呼ぶ）。keep-alive の待機に渡した signal が abort → 待機が reject → `catch { break }` でループ即脱出。30 秒待たない。
2. **副**: ループ本体の `while (!closed)` と `if (!closed)` ガード。`stream.write()` 中に abort されてもその周で抜ける。

**この「主」の効果は、`sse.app.request("/sse")` のレスポンス body が EOF に達するかで観測できる（AC-7）。** 本計画で実測: 現行実装（abort あり）は `closeAll()` から **0ms** で `read()` が `done: true` を返す。`abortController.abort()` を取り除いた複製実装では **1000ms 経っても `read()` が解決しない**。したがってこのテストは「主」が失われたら確実に落ちる。

**「第 3 層（`closeAllConnections()` によるソケット破棄で `stream.write()` が reject → `.catch(cleanup)`）」は存在しない。** `node_modules/hono/dist/utils/stream.js` の `StreamingApi.write()` は

```js
async write(input) {
  try { ...; await this.writer.write(input); } catch { }   // ← すべて握りつぶして resolve
  return this;
}
```

と例外を握りつぶすため、`src/server/routes/sse.ts:84` の `await stream.write(": keep-alive\n\n").catch(cleanup)` の `.catch(cleanup)` は**決して発火しないデッドコード**である（実コードを読んで確認済み）。同様に `client.send` の `stream.writeSSE({...}).catch(cleanup)`（`sse.ts:66`）も、`writeSSE` が throw するのは `event`/`id`/`retry` に `\r\n` が混ざった場合だけなので実質デッドコードである。

**`.catch(cleanup)` の扱い（方針）**: `stream.write(...)` 側の `.catch(cleanup)` は **削除**し、「Hono の `StreamingApi.write()` は例外を握りつぶすため reject しない」という事実を 1 行コメントで残す。`writeSSE` 側の `.catch(cleanup)`（`client.send`）は **残す** — `event` に不正文字が入った場合に実際に reject しうる経路であり、削除すると unhandled rejection になる。

マネージャ単位の `AbortController` を追加して `AbortSignal.any([clientSignal, managerSignal])` にする案も検討したが、上記 2 層で漏れが無く、client あたりのアロケーションが増えるだけなので採らない（ADR-003）。

**keep-alive の待機を `node:timers/promises` に置き換える（ADR-006）**: 現行の手書き `sleep()` は正常完了時に abort リスナーを解除しないためリークする（本計画で実測: 25 回正常完了で 25 個）。Node 標準の中断可能タイマーに置き換えるとリークが構造的に消え（同条件で 0 個）、手書きヘルパ自体が不要になる。

```ts
import { setTimeout as delay } from "node:timers/promises";
// ...
try {
  await delay(KEEP_ALIVE_INTERVAL_MS, undefined, { signal: abortController.signal });
} catch {
  break;  // abort で中断された — 期待どおり
}
```

**この置き換えのトレードオフ**: vitest の fake timers はグローバル `setTimeout` は差し替えるが **`node:timers/promises` は差し替えない**（本計画で実測確認）。したがって置き換え後は keep-alive ループをフェイクタイマーで進められなくなる。本 Issue では周期挙動をテストする要求が無いので許容する。**この非対称性に AC-8 の判別性を依存させることはしない**（3 周目で変更）— AC-8 のテストはレスポンス body を読み捨てることで、fake timers に駆動される実装でもされない実装でも「client 1 本あたりのリスナーが 1 個を超えない」という性質そのものを見る形になっている（上表 (d) 参照）。

### HTTP サーバーのライフサイクル（`src/server/index.ts`）

`ServerInstance` を「全部落とすか、何もしないか」の 2 択に絞る。

```ts
export type StartServerOptions = {
  readonly shutdownTimeoutMs?: number;
};

export type ServerInstance = {
  readonly shutdown: () => Promise<void>;
};

export async function startServer(
  config: ServerConfig,
  options?: StartServerOptions,
): Promise<ServerInstance>;
```

- `close` / `sseCloseAll` / `watcher` をすべて削除し、**メソッド 1 つのハンドル型**にする（ADR-005）。`watcher` の削除は実装レビューでの反転（削除基準の後半「誤用で不整合状態を作れる」を満たすため）。
- **タイムアウト予算の注入口は `shutdown()` の引数ではなく `startServer()` の第 2 引数**（ADR-008、実装レビューでの変更）。当初は `shutdown(options?: { timeoutMs })` としていたが、`shutdown()` は memo 化されるため「2 回目以降は無視される引数」という契約矛盾が生まれる。予算は**インスタンスの寿命に対して 1 回だけ決まる値**なので生成時に受け取れば、矛盾が型のレベルで消える。既定値の解決は `options?.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS` を `startServer()` の冒頭で 1 回行う。
- `shutdownTimeoutMs` は**テスト注入のための任意引数**であり、AC-3 のテスト（`startServer(config, { shutdownTimeoutMs: 0 })`）が実際に使うためデッド API にはならない。`0` / 負数 / `NaN` が「即座に諦めて警告を出す」を意味することと既定値の実数（2,000ms）は、非公開の `withTimeout` ではなく**公開面である `StartServerOptions` の doc に書く**。

`closeAllConnections()` は `in` でナローイングする。型述語 `isHttpServer` への置き換えは**実装レビューで撤回した**（ADR-004）。`in` は TypeScript の制御フロー解析がコンパイラとして検証するナローイングだが、手書きの型述語は本体と述語の整合が検証されない（`return true;` でもコンパイルが通る）ため、置き換えは型安全性の後退になる。呼び出し箇所も 1 つしかないので、なぜナローイングが必要かの説明は `in` の直上のコメントに置く。

シャットダウン手順（**順序が仕様**。各ステップに理由コメントを付ける）:

```
   const failures: unknown[] = []
   // 非同期な手順を型で拒む（下記「手順が同期であることを型で表明する」）
   const step = <T>(run: () => T extends PromiseLike<unknown> ? never : T) => {
     try { run() } catch (e) { failures.push(e) }
   }

1. const closing = close()    // server.close(): リスナーを閉じ、新規接続の受付を止める
2. step(() => sse.shutdown()) // 新規 /sse を拒否し、既存ストリームを abort
3. step(() => watcher.close()) // これ以上 broadcast を発生させない
4. step(() => { if ("closeAllConnections" in server) server.closeAllConnections() })
                              // 送信中の SSE を抱えた active ソケットを destroy
5. try {
     const outcome = await withTimeout(closing, shutdownTimeoutMs)
     if (outcome.status === "timed-out") logger.warn(...)
   } catch (e) { failures.push(e) }

   if (failures.length === 1) throw failures[0]
   if (failures.length > 1) throw new AggregateError(failures, "...")
```

- **`close()` が手順 1 である（実装レビューで改訂）。** 当初の計画は `sse.shutdown()` を手順 1、`close()` を手順 2 としていたが、これは本節の根拠と矛盾していた — 「再接続を誘発する操作より前にリスナーを止める」と言いながら、その前に走る `sse.shutdown()` こそが接続中の SSE を全部終端させてブラウザの `onerror` → 自前リトライを誘発する操作だからである。`close()` を先頭に置けば根拠と実装が一致し、**Issue 本文の修正案 1 とも一致する**。入れ替えで壊れるものは無い（`sse.shutdown()` はフラグを立てて `clients` を走査するだけで、リスナー閉鎖の前後を問わず取りこぼさない）。
- **手順 2 / 3 / 4 は個別に捕捉する（実装レビューで追加）。** まとめて 1 つの `try` に入れると、手順 2 の throw が手順 3・4 を巻き添えにする。手順 4（`closeAllConnections()`）は「有界待機に落ちずに速く終わる」ことを担保している唯一の手順なので、これが飛ぶと毎回予算をフルに使う。フォールト注入で実測: **単一 `try`（手順 4 が飛ぶ）は 2,003ms + 警告 / 個別捕捉は 1ms + 警告なし**。
- **失敗チャネルは配列にする（実装レビューで追加）。** 単一スロットだと、手順 5 の `await` が予算内 reject で throw した場合に捕捉済みのエラーがどこにも記録されずに消える。手順 5 も `try`/`catch` で包んで `failures` に**追加**し、**1 件ならそのまま throw**（`server.close()` のエラーが CLI の `logger.error` に届く既存挙動を維持）、**2 件以上なら `AggregateError`** にする。`Result<T, E>` は使わない（「関数の返り値としての成否」ではなく「後で throw するために保留した例外」なのでレイヤが違う）。
- 1〜4 は同期。ただし**同期であることに安全性を依存しない**（依存しているのは 2 のフラグと 1 のリスナー閉鎖）。
- **手順が同期であることを型で表明する（実装レビュー 3 ラウンド目で追加）。** `step(run: () => void)` は戻り値 `void` の位置に任意の値を許すため、将来どれかの手順が `Promise<void>` を返すようになっても型エラーにならず、その失敗は `failures` に載らず・手順 5 より前に完了せず・unhandled rejection になる。ADR-009 が再入ガードで「コメントだけの不変条件は採らない」と決めた基準を同じ関数内の `step()` にも適用し、`<T>(run: () => T extends PromiseLike<unknown> ? never : T)` で拒む（ADR-002）。`<T extends void>` では効かない（`T` が `void` に推論されて通る）。
- `closeIdleConnections()` は**併用しない**。`closeAllConnections()` はアイドル接続も含む上位互換で、graceful drain をしない以上追加の意味が無い（ADR-002）。
- **手順 4 が必要な理由は「アイドルの keep-alive ソケットが残るから」ではない（実装レビューで訂正）。** Node 19 以降の `http.Server.prototype.close` は先頭で `httpServerPreClose()` → `closeIdleConnections()` を呼んでおり（`engines` は `>=22.0.0` なので常にこの経路）、**アイドル接続は `close()` 自身が始末する**。手順 4 が要るのは**送信中の SSE レスポンスを抱えた active ソケット**に対してだけである。根拠を誤って書くと「`close()` が呼ぶなら手順 4 は不要では」と削除され、毎回 2 秒のタイムアウトに落ちるようになる。
- **タイムアウト打ち切り時に `closeAllConnections()` を再度呼ぶことはしない**（ADR-007）。手順 1 でリスナーを閉じているため手順 4 以降に新規ソケットは accept されず、destroy 済みソケットへの再 destroy は no-op である。「効く場面が構成上存在しない」処理を保険として置かない。
- `close()` を memo 化する（`closePromise ??= new Promise(...)`）。`server.close()` を 2 度呼ぶと 2 回目のコールバックが `ERR_SERVER_NOT_RUNNING` を返すため、内部でも二重呼び出しを起こさないようにする。
- タイムアウト定数は `src/server/index.ts` にモジュール定数 `SHUTDOWN_TIMEOUT_MS = 2_000` として置く。サーバー専用でクライアントと共有しないため `src/core/sse-constants.ts` には置かない。

**再入ガードは手順の同期性から独立させる（ADR-009、実装レビューで追加）。** `shutdownPromise = (async () => {...})()` は右辺の IIFE が最初の `await` に到達するまで同期実行され、**代入はその後**に完了する。つまり手順 1〜4 の実行中は memo が `undefined` のままで、その窓で再入すると手順が二重に走る。今日は到達しないが、「同期実行だから安全」はこの PR がまさに消そうとしている依存なので、`shutdown()` 本体にも同じ基準を適用する。

```ts
shutdown() {
  if (shutdownPromise) return shutdownPromise;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  shutdownPromise = promise;          // executor は同期実行 → 本体より前に代入が完了する
  runShutdown().then(resolve, reject);
  return promise;
}
```

`Promise.resolve().then(run)` にすると AC-4（最初の `await` の前にリスナーが閉じている）が崩れるので採らない。`Promise.withResolvers` は Node 22+ / ES2024 で、`engines` は `>=22.0.0`、`tsconfig.json` の `target` / `lib` はいずれも `ES2024` なので追加の前提は不要。

**タイムアウト打ち切り時の残存リソース**: 打ち切って resolve した時点で、`server.close()` のコールバックはまだ発火していない。ただし **リスニングハンドル自体は手順 1 の時点で既に閉じており、ポートは即座に解放される**（`server.close()` 呼び出し後、コールバック未発火の状態で同じポートに再 bind できることを 1 周目に実測）。したがってテストからの連続実行でポート衝突は起きない。残るのは destroy し切れていないソケットハンドルの可能性のみで、これは追加処理では解消できないため、`ServerInstance.shutdown` の doc コメントに「タイムアウト時はソケットハンドルが残りうる。プロセスを終わらせる責務は呼び出し側（CLI）にある」と明記して契約として示す。

### UI / プレゼンテーション

変更なし。クライアントの再接続は既存のバックオフのまま（2 実装とも）。503 を受けても `onerror` 経由の自前リトライという挙動は変わらず、`server.close()` 済みなのでリトライは TCP レベルで失敗して 10 回で収束する。

### CLI（`src/index.ts`）

**観測性のための最小変更 1 箇所のみ行う**（プロセス制御の構造は変えない）。

- **シグナル受信ログ** — `process.on("SIGINT", handler)` はハンドラ第 1 引数にシグナル名を渡す。ハンドラを `async (signal: NodeJS.Signals) => { ... }` にし、既存の `console.log()`（空行）の**後**・`intro(...)` の**前**に `logger.info(\`Received ${signal}, shutting down...\`)` を出す。これにより次回再発時に「SIGINT ハンドラが起動したのか、そもそも起動していなかったのか」を事後に判別できる（調査結果 (i)/(ii) の切り分け）。**挿入位置を `console.log()` の後にするのは、前に置くと端末の `^C` エコーと同じ行に連結して表示され、既存コードが `console.log()` で `^C` と `intro()` を分離している意図を壊すため**（ADR-007）。

それ以外は変更しない:

- **stdio drain は入れない**（スコープ「含まれないもの」/ ADR-007）。
- `shutdown()` が有界になったことで、既存の `await server.shutdown()` → `outro()` → `process.exit(0)` が必ず到達する。
- `process.exit` をサーバー層に持ち込まない（ADR-001）。CLI がプロセス制御の唯一の責務者という現状の構造は正しい。
- 2 回目シグナルでの force exit（`process.exit(1)`）は最終保険として残す。

## 実装ステップ

依存方向の順（内側 → 外側）に並べる。**グループ A とグループ B は別コミットに分ける**（できれば別 PR）。Issue の要件はグループ A だけで満たされるため、B で回帰が出ても要件充足分を残せる。**順序は逆にしない。**

---

### グループ A: 要件充足（Ctrl+C で必ず終了する）

### 1. `withTimeout` ユーティリティの追加

- **対象ファイル:** `src/lib/with-timeout.ts`（新規）
- **変更内容:**
  - `TimeoutOutcome<T>` 判別可能ユニオンと `withTimeout<T>(promise, timeoutMs): Promise<TimeoutOutcome<T>>` を実装する。
  - **予算ゼロの判定は `!(timeoutMs > 0)`**（`timeoutMs <= 0` ではない）。`NaN` も予算ゼロに落とすため（実測: `NaN <= 0` は false で `setTimeout(NaN)` = 約 3ms 経路に落ちる。`!(NaN > 0)` は true）。この分岐は `{ status: "timed-out" }` を早期 return する。この経路でも `promise.catch(() => {})` を張って unhandled rejection を防ぐ。
  - doc コメントには「**予算ゼロのときは `promise` の settle 順序と無関係に決定的に `timed-out` を返す**」と書く（「同期的に resolve する」とは書かない — 呼び出し側から見れば `await` は常に非同期であり誤読を招く。実装メモとしてなら併記可）。「予算ゼロ = 常にタイムアウト」という意味論と、これが AC-3 の自動検証を可能にすることも書く。
  - それ以外は `new Promise` 内で `setTimeout` を張る。`promise.then(v => resolve({status:"completed", value:v}), e => reject(e))` を接続し、決着時に `clearTimeout`。
  - **`timer.unref()` は呼ばない。** 理由（unref すると「close が解決せず ref 付きハンドルも無い」場合にタイマーが発火せず、AC-3 の `logger.warn` ごとシャットダウン終盤がスキップされる／ref のままでも `clearTimeout` により teardown は遅延しない）を doc コメントに 1 行残す。実測は「設計」節の表を参照。
  - reject ハンドラを必ず接続することで、タイムアウト後に `promise` が reject しても unhandled rejection にしない。
  - **配置根拠は doc コメントに書かない**（正しい結論は「`src/core/` でも `src/lib/` でも壊れない」なので書く価値が薄く、誤った基準を恒久コメントとして残すと将来の配置判断を誤らせる）。`.issue/102/adr.md` ADR-001 への参照 1 行だけを残す。
  - doc コメントには「reject を透過するのは予算内に reject した場合だけで、予算超過後・予算ゼロ経路の reject は購読するが破棄される」ことも書く（実装レビューで追加）。
- **理由:** AC-1 / AC-2 / AC-3 の保証を担う中核。`src/server/index.ts` から切り出すことで、実際に再現困難な「close が解決しない」状況を単体テストで直接検証できる（テスト可能性の確保）。

### 2. `withTimeout` の単体テスト

- **対象ファイル:** `src/lib/with-timeout.test.ts`（新規）
- **変更内容:**
  - 期限内に解決 → `{ status: "completed", value }` を返す。
  - **永久に解決しない Promise（`new Promise(() => {})`）を渡すと、指定 ms 後に `{ status: "timed-out" }` で解決する**（= AC-2 の中核。実サーバーでは再現できないシナリオをここで直接検証する）。
  - **`timeoutMs: 0` は、既に解決済み / `process.nextTick` で解決する Promise を渡しても必ず `{ status: "timed-out" }` を返す**（AC-3 の前提。20 回ループで決定性を確認する）。
  - **`timeoutMs: NaN` も同様に `{ status: "timed-out" }` を返す**（`!(timeoutMs > 0)` を採ったことの確認。1 ケース）。
  - 期限内に reject → 返り値の Promise が reject する。
  - タイムアウト後に元の Promise が reject しても unhandled rejection が発生しない（`process.on("unhandledRejection")` を一時的に張る）。`timeoutMs: 0` の経路でも同様に確認する。
  - 期限内に解決した場合、タイマーが残らない（テストが `timeoutMs` 分ブロックしないこと自体で担保）。**`unref()` を使わないため、ここが `clearTimeout` の唯一の自動検証になる。** 実測（タイムアウト 300ms / 10ms で解決する Promise）: `clearTimeout` あり・unref なしは **14ms でプロセス終了**、`clearTimeout` を落とすと completed 後も **303ms 生き残る**。
- **理由:** AC-2 の唯一の決定的な自動検証、および AC-3 の前提の確立。

### 3. `shutdown()` の有界化と順序変更

- **対象ファイル:** `src/server/index.ts`
- **変更内容:**
  - `SHUTDOWN_TIMEOUT_MS = 2_000` をモジュール定数として定義する。
  - `close` を memo 化する（`let closePromise: Promise<void> | undefined`）。
  - **`startServer` に第 2 引数 `options?: StartServerOptions`（`shutdownTimeoutMs?: number`）を足し、冒頭で `options?.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS` を 1 回だけ解決する**（ADR-008。当初は `shutdown(options)` の予定だったが memo 化との契約矛盾のため移した）。`StartServerOptions` の doc に既定値の実数（2,000ms）と「非正値 / `NaN` は『即座に諦めて警告を出す』であって『無制限に待つ』ではない」を書く。タイムアウト時はソケットハンドルが残りうること（プロセス終了の責務は呼び出し側）は `ServerInstance.shutdown` の doc に書く。
  - `shutdown()` の本体を「設計」節の 1〜5 の順に書き換え、各行に順序の理由をコメントで残す。**手順 2 / 3 / 4 は `step()` ヘルパで個別に捕捉し、手順 5 の reject も `failures` に追加して、1 件ならそのまま throw / 2 件以上なら `AggregateError` にする。** タイムアウト時は `logger.warn` を出す（AC-3）。**打ち切り時の再 `closeAllConnections()` は入れない。**
  - **再入ガードを `Promise.withResolvers()` で先に公開する**（ADR-009）。手順本体は `runShutdown()` という名前付き関数に出し、`shutdown()` は memo とガードだけを持つ。
  - この段階では `sse.closeAll()` の呼び出し名はそのまま（改名はグループ B のステップ 6）。
- **理由:** AC-1 / AC-2 / AC-3 / AC-4 / AC-11。原因未特定に対する最終保証（タイムアウト）と、順序の構造的修正を成立させる。

### 4. 終了性・タイムアウト警告テスト

- **対象ファイル:** `src/index.shutdown-process.test.ts`（新規） / `src/server/index.test.ts`
- **変更内容:**
  - **新規（AC-1）**: `child_process.spawn` でプロセスを起動し、SSE 接続を張った状態で `child.kill("SIGINT")` を送り、`close` イベントまでの経過時間と exit code を assert する。**配置は `src/server/` ではなく `src/index.shutdown-process.test.ts`**（実装レビューで変更） — テスト対象は CLI エントリ（`src/index.ts`）であり、既存の aspect-suffix の前例（`src/lib/watcher.error-handling.test.ts`）とも整合する。運用詳細を以下に確定させる（すべて本計画で実測して動作確認済み）。
    - **起動コマンド**: `spawn(process.execPath, ["--import", "./src/loaders/css.mjs", "--import", "tsx/esm", "src/index.ts", <fixtureDir>, "--port", String(port), "--no-open"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })`。`node_modules/.bin/tsx` 経由でも動く（実測: 起動 496ms / SIGINT→close 73ms / exit 0）が、**ラッパープロセスを挟まない `process.execPath` 版を採用する**（実測: 起動 319ms / SIGINT→close 7ms / exit 0。シグナル配送経路が単純で CI での不確実性が小さい）。
    - **起動完了の検出**: `fetch("http://localhost:<port>/")` が 200 を返すまで **150ms 間隔でポーリング（上限 20 秒）**。返ってきた body は `arrayBuffer()` で読み切る。**stdout の文言に依存しない**（@clack の装飾・非 TTY 挙動に引きずられるため）。**各周で子プロセスの `exitCode` / `signalCode` を見て、死んでいたら即座に出力付きで失敗させる**（`getFreePort()` が返したポートを他者に取られて `Port N is already in use` で即死した場合、これが無いと 20 秒後に「起動しなかった」としか分からない）。個々の `fetch` にも `AbortSignal.timeout(1_000)` を付けて有界にする（ポートを握った相手が accept したまま応答しないとループごと止まるため）。以上 2 点は実装レビューで追加した。
    - **空きポート**: `src/server/index.test.ts` の `getFreePort()` と同じ実装を新規テストファイルにも置く（**複製する**。共有ヘルパへの切り出しは本 Issue のスコープを増やすので行わない）。
    - **fixture**: `beforeAll` で `mkdirSync` + `writeFileSync` により `README.md` 1 つを持つディレクトリを作り、`afterAll` で `rmSync`。既存テストと同じ流儀。ディレクトリモードは `initMarkdown()`（shiki）を通るが、起動は実測 319ms で `testTimeout: 30000` の枠に十分収まる。
    - **後始末**: `close` を待つ Promise を 10 秒でタイムアウトさせ、超過したら `child.kill("SIGKILL")` してから失敗させる。`finally` で SSE 用 `fetch` レスポンスの `body.cancel()` と、未終了なら `SIGKILL` を必ず実行する。
    - **ビルド成果物**: 追加要件なし。CLI が要求する `src/server/renderer/global.css` / `client-bundle.js` / `favicon.js` は `pretest` が生成しており、既存の `src/server/index.test.ts` も同じ前提で動いている。
    - **アサーション（実装レビューで強化）**: exit code 0 と経過時間だけでは判別性が無い — `shutdown()` の同期部が ref 付きハンドルを全部解放するため、**永久に settle しない `shutdown()` でもイベントループが枯渇して Node が自分で exit 0 する**（実測: 6ms・`Server stopped` なし）。したがって (a) 出力に `Server stopped` が含まれること（`outro()` は `await server.shutdown()` の直後・`process.exit(0)` の直前なので、これが settle の証拠になる）、(b) exit code が 0、(c) 経過時間が **AC-1 の 5 秒ではなく有界待機の予算 2 秒未満**（タイムアウトに救われただけの終了を落とすため）、(d) 出力に `did not close within` が**含まれない**（AC-3 の偽陽性なしをプロセスレベルでも見る）、の 4 点を assert する。
  - **追加（AC-4）**: 2 本立てにする（実装レビューで追加）。
    1. **end-to-end 側**: `const p = server.shutdown();` を await せずに `await expect(fetch(url)).rejects.toThrow();` してから `await p;`。ただしこれは「`shutdown()` が返った後に接続が拒否される」ことしか言えない（`fetch` が TCP connect に至るのは数 ms 後）。
    2. **手順順序側**: `serve()` / `SseManager.shutdown()` / `createFileWatcher()` を `vi.doMock` でスタブし、手順 1〜4 の呼び出しを配列に記録する。`instance.shutdown()` の**直後に同期的に** `calls` を読み、`["close", "sse.shutdown", "watcher.close", "closeAllConnections"]` であることを assert する。手順 1〜4 はすべて同期なので実ソケット越しの観測では順序を判別できず、**スタブが順序を観測可能にする唯一の手段**である。`const closing = close()` を `closeAllConnections()` の後ろに戻すとここが落ちる。**4 手順すべてを記録する**（手順 3 = `watcher.close()` は実装レビュー 3 ラウンド目で追加した。それまでは手順 3 を削除しても全テストが通っていた）。
  - **追加（AC-3）**: `src/server/index.test.ts` に 2 ケース追加する。
    1. SSE 接続を張った状態で `startServer({ ...baseConfig, port }, { shutdownTimeoutMs: 0 })` のサーバーに対して引数なしの `shutdown()` を呼ぶと、`vi.spyOn(console, "warn")` が「期限内に close しなかった」旨のメッセージを受け取る。**本計画で同形の手順を実測: 10/10 で timed-out 分岐 + 警告出力。**
    2. SSE 接続を張った状態で既定タイムアウト（`shutdown()`）を呼ぶと `console.warn` が **1 度も呼ばれない**（偽陽性が無いことの確認）。**本計画で実測: 10/10 で completed・警告 0 件。**
    - スパイ対象は `logger` オブジェクトではなく `console.warn` にする（`logger` は `as const` で `readonly` 宣言されているため）。
  - **追加（AC-11、実装レビュー 2〜3 ラウンド目）**: `describe("shutdown error isolation")` に 3 ケース。手順順序テストと同じスタブ土台（`withStubbedServer`）を使い、各手順に throw を注入する。
    1. 手順 2（`sse.shutdown()`）が throw し、`close()` のコールバックを永久に呼ばない状態で `shutdownTimeoutMs: 30` → 後続手順が `calls` に載る / 経過時間が予算以上 / 警告 1 回 / 失敗 1 件なので `AggregateError` に**包まれない**こと。
    2. 手順 3（`watcher.close()`）と手順 4（`closeAllConnections()`）が両方 throw → `calls` は 4 手順すべて / `AggregateError.errors` に 2 件とも順序どおり載ること。**実運用で最も throw しうるのは手順 3（`fs.FSWatcher` の close）なのでここに注入する。**
    3. 手順 4 が throw し、`closing` も予算内に reject → 手順 5 の失敗が上書きではなく**追加**されて `AggregateError` に 2 件載ること。
  - 既存 5 ケースはそのまま通ることを確認する（AC-9）。
- **理由:** AC-1 / AC-3 / AC-4 / AC-9 / AC-11。Issue の唯一の要件（プロセスが終了する）を初めて回帰テスト化し、タイムアウト警告経路も自動検証に載せる。CI matrix（Node 22 / 24）により Node 24 上でも自動実行される。

---

### グループ B: 再発防止・付随整理

### 5. CLI のシグナル受信ログ

- **対象ファイル:** `src/index.ts`
- **変更内容:**
  - `const shutdown = async (signal: NodeJS.Signals) => { ... }` にし、既存の `console.log()`（空行）の**後**・`intro(...)` の**前**に `logger.info(\`Received ${signal}, shutting down...\`)` を 1 行追加する。
  - force exit 分岐（`process.exit(1)`）は変更しない。
  - **stdio drain は追加しない**（ADR-007）。
- **理由:** AC-10。調査結果の (ii)「SIGINT ハンドラがそもそも起動していなかった可能性」を次回再発時に切り分けるため。要件充足には寄与しないのでグループ B に置く。

### 6. `SseManager` の終端化・シャットダウン中フラグ・`sleep()` の置き換え

- **対象ファイル:** `src/server/routes/sse.ts`
- **変更内容:**
  - クロージャに `let shuttingDown = false;` を追加する。
  - `closeAll()` を `shutdown()` に改名し、**先頭で `shuttingDown = true` を立ててから** `clients` を走査 → `clear()` する順序にする。順序が本質である旨と、「以後 `broadcast()` は空の `Set` を回るだけの no-op になる」ことを doc コメントに書く。
  - `SseManager` 型の `closeAll` を `shutdown` に置き換える。
  - `/sse` ハンドラ冒頭で `if (shuttingDown) return c.body(null, 503);`。
  - `streamSSE` コールバック内を **`stream.onAbort(cleanup)` → `if (!closed) clients.add(client)` → `if (shuttingDown) { cleanup(); return; }` の順**にする（実装レビューで `onAbort` を前倒しし `!closed` ガードを追加）。二重チェックの意図（フラグ公開 → 走査 / 自己登録 → フラグ再チェック）、`onAbort` を先に登録する理由（`StreamingApi.abort()` は登録済みリスナーにしか通知せず `aborted` をラッチする）、`!closed` ガードの理由（死んだ client を `clients` に残さない）、②に落ちた場合は 200 + 即 EOF になること、および**②は現行の Hono では到達不能**（ハンドラ〜最初の `await` が同一同期ブロックで `sse.shutdown()` も同期のため）で、将来 `clients.add()` より前に `await` が入った場合の保証として残すことをコメントで明記する。
  - **手書きの `sleep()` を削除**し、`import { setTimeout as delay } from "node:timers/promises";` に置き換える。keep-alive の待機を `await delay(KEEP_ALIVE_INTERVAL_MS, undefined, { signal: abortController.signal })` にする（ADR-006）。
  - `await stream.write(": keep-alive\n\n").catch(cleanup)` の `.catch(cleanup)` を削除し、「Hono の `StreamingApi.write()` は例外を握りつぶすため reject しない」というコメントを残す。`client.send` 内の `writeSSE(...).catch(cleanup)` は残す（不正な `event` 名で実際に reject しうる）。
  - **`broadcast()` への `shuttingDown` ガードは追加しない** — `shutdown()` が `clients.clear()` するので既に no-op であり、フラグ判定を足しても実行結果は変わらない。契約はコメントで示す。
  - 改名に伴い、呼び出し側（`src/server/index.ts` の listen エラー時クリーンアップと `shutdown()` 内）の `sse.closeAll()` を `sse.shutdown()` に追随させる（このステップ単体でビルドが通る状態を保つ）。
- **理由:** AC-5 / AC-6 / AC-7 / AC-8。レースを「同期実行の副作用」ではなく「フラグと再チェックという構造」で塞ぐ。あわせて keep-alive ループ内の実測欠陥（リスナーリーク）を解消する。

### 7. SSE マネージャのテスト更新・追加

- **対象ファイル:** `src/server/routes/sse.test.ts`
- **変更内容:**
  - 既存の `closeAll` 呼び出しを `shutdown` にリネームする（`afterEach` を含む）。
  - 追加（AC-5）: `shutdown()` 後に `sse.app.request("/sse")` が **503** を返し、`content-type` が `text/event-stream` **でない**（= ストリームを開始していない）。
  - 追加（AC-6）: `shutdown()` 後に `/sse` を叩いても `clientCount` が 0 のままである（50ms 待ってから検証。既存テストの待ち方に合わせる）。
  - 追加: 接続済み client がある状態で `shutdown()` すると `clientCount` が 0 になり、その後の新規接続も登録されない（`closeAll resets clientCount to zero` の拡張）。
  - **追加（AC-7）**: `const res = await sse.app.request("/sse");` → 50ms 待機 → `const reader = res.body.getReader();` → `sse.shutdown();` → `reader.read()` が **500ms 以内に `{ done: true }` を返す**ことを assert する（`Promise.race` でタイムアウトを付け、超過したら失敗させる）。`app.request` 経路にはソケットが無いため `closeAllConnections()` に救われる余地が構造的に無く、**per-client abort が失われたら必ず落ちる**。本計画で実測: 現行実装は 0ms で `done: true`、`abortController.abort()` を除去した複製は 1000ms 経っても解決しない。
  - **追加（AC-8）**: `createSseManager()` を実際に経由して abort リスナー数を検証する。**3 周目の最終形（body 読み捨て + positive control + `sse.shutdown()` による後始末）を以下に確定させる。この形のまま実際に走らせて (a)/(b)/(c) の 3 方向を実測済み。**
    ```ts
    const signals: AbortSignal[] = [];
    const Orig = globalThis.AbortController;
    class Spy extends Orig { constructor() { super(); signals.push(this.signal); } }
    globalThis.AbortController = Spy as typeof AbortController;
    let sse: ReturnType<typeof createSseManager> | undefined;
    try {
      vi.useFakeTimers();
      sse = createSseManager();
      const resPromise = sse.app.request("/sse");
      await vi.advanceTimersByTimeAsync(0);
      const res = await resPromise;

      // レスポンス body を読み捨てて keep-alive ループを実際に周回させる。
      // これをしないと Hono の TransformStream のバックプレッシャーでループが
      // 1 周で止まり、リークが線形増加として現れない（判別マージンが 1 しか出ない）。
      const reader = res.body?.getReader();
      // 読み捨てを黙って飛ばさない: reader が無いまま進むと判別マージンの無い
      // 旧形（max 2）に退化し、Hono のバッファリングが変われば false-green になる。
      if (!reader) throw new Error("No reader — the drain gives this its margin");
      void (async () => {
        try { while (true) { const { done } = await reader.read(); if (done) break; } } catch { /* closed */ }
      })();

      const counts: number[] = [];
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        counts.push(...signals.map((s) => getEventListeners(s, "abort").length));
      }

      // positive control: これが無いと「ハンドラが keep-alive 待機に到達しない実装」で
      // counts = [0,0,...] → max = 0 となり無検証のまま緑になる（vacuous pass）
      expect(signals.length).toBeGreaterThan(0);
      expect(sse.clientCount).toBe(1);
      expect(counts).toContain(1);

      expect(Math.max(...counts)).toBeLessThanOrEqual(1);
    } finally {
      sse?.shutdown();          // fake timers に駆動されない実 30 秒タイマーを後始末する
      vi.useRealTimers();
      globalThis.AbortController = Orig;
    }
    ```
    - `signals` には Hono 内部の `AbortController` も混ざるため **`signals[0]` 決め打ちにせず全 signal を見る**（実測: `signals.length = 2`、Hono 側は常に 0）。`Math.max(...[])` が `-Infinity` になって無条件に通るケースは `expect(signals.length).toBeGreaterThan(0)` で塞ぐ。
    - **本計画でこの最終形を 3 実装に対して実際に走らせた実測結果（5 tick、各 tick で全 signal のリスナー数を記録）**:

      | 実装 | 各 tick の最大リスナー数 | `clientCount` | 判定 |
      |---|---|---|---|
      | (a) `node:timers/promises` 版（本計画の実装） | `[1,1,1,1,1]` | 1 | **pass** |
      | (b) 手書き `sleep()` に戻したもの | `[2,3,4,5,6]` | 1 | **fail**（`toContain(1)` と `max <= 1` の両方） |
      | (c) ②の再チェックが常に真で keep-alive 待機に到達しない | `[0,0,0,0,0]` | 0 | **fail**（`expect(sse.clientCount).toBe(1)` が捕捉） |

    - **`sse.shutdown()` を `finally` に必ず入れる**（アーキ S-204）。`node:timers/promises` の `delay()` は既定 `ref: true` かつ fake timers に駆動されないため、テスト中に張られた 30 秒タイマーが**実タイマーとして残る**。`shutdown()` が client を abort すれば `delay()` が reject してタイマーが解放される。`vi.useRealTimers()` / `globalThis.AbortController` の復元と**同じ `finally`** に置くこと（片方だけ復元されると同一ファイルの後続ケースが壊れる）。
    - **このテストが証明する範囲は「AC-8 が証明する範囲」の注記のとおり**（(b) の再導入は必ず検出するが、(a) について「N 回正常完了してもリークしない」ことの実行時証明ではない）。上表の実測値と併せてテストにコメントで残す。
- **理由:** AC-5 / AC-6 / AC-7 / AC-8 / AC-9 を Hono の `app.request` レベルで決定的に検証できる。ここが本 Issue で唯一「レース対策そのもの」を自動テストできる層。

### 8. `ServerInstance` の API 縮小

- **対象ファイル:** `src/server/index.ts`
- **変更内容:**
  - `ServerInstance` から `close` / `sseCloseAll` / `watcher` を削除し、`{ shutdown: () => Promise<void> }` の 1 メソッド型にする。`close` の実体（memo 化された内部関数）と `watcher` は `shutdown()` のクロージャが握る内部実装として残る（`startServer` の内部構造は変わらない）。
  - **型述語 `isHttpServer` の導入は行わない**（実装レビューで撤回。ADR-004）。`in` によるインラインナローイングをそのまま残し、なぜナローイングが必要か（`serve()` の戻り値が `ServerType` union で `closeAllConnections` は `http.Server` にしかない／peek は常に plain HTTP サーバーを作る）を `in` の直上のコメントで説明する。`node:http` / `@hono/node-server` の型 import も不要。
- **理由:** 付随整理（ADR-005）。誤用で本 Issue のハングや不整合状態を再現できる経路を型レベルで消す。**受け入れ基準は伴わない**（AC-9 の既存テスト通過でカバーされる）。

### 9. 手動確認と記録

- **対象ファイル:** なし（コード変更なし）
- **変更内容:**
  - **グループ A を単独でマージする場合も、本ステップの (1)(2) は必ず実施する。** グループ A こそが要件充足を担う変更であり、それを手動確認しないままマージすると「要件を満たした部分だけ無検証」という逆転が起きる。グループ B のマージ後に全項目を再実施する。
    - **グループ A 単独マージ時の最小手順**: `pnpm dev` 相当で起動 → ブラウザタブを開いたまま数分放置 → Ctrl+C。(a) 5 秒以内に `Server stopped. Bye!` が出て終了すること、(b) タイムアウト警告の有無、の 2 点を **3 回**記録する。`Received SIGINT, ...` の確認はステップ 5 を含まないため対象外。
  - `peek . --host 0.0.0.0 --port 3009` をブラウザタブ常時オープンで起動し、しばらく放置した後 Ctrl+C を押す試行を **10 回**繰り返す。ディレクトリモード / HTML ファイルモード / 複数タブの各条件で行う。
  - **記録項目（毎回）**:
    1. `Shutting down...` および `Received SIGINT, shutting down...` が表示されたか（= SIGINT ハンドラが起動したか。調査結果 (i)/(ii) の切り分け）
    2. `Server stopped. Bye!` が出て終了するまでの所要時間（5 秒以内か）
    3. `[peek] ... did not close within ...` 警告の有無（= タイムアウトに救われたのか、構造対策で直ったのか）
  - **少なくとも 1 回は `peek . 2>&1 | tee /tmp/peek-shutdown.log` のようにリダイレクトした状態で実施し、(i) 警告ログが欠落しないこと、(ii) exit code が 0 のままであること を確認する**（stdio drain を入れないという判断の妥当性確認）。
  - **Node 24 での手動確認は「実ブラウザ + 実 Ctrl+C + macOS」に限定する。** CI matrix が `ubuntu-latest` × Node 22 / 24 で `pnpm test` を回すため、ステップ 4 のプロセスレベル終了性テスト（AC-1）は Node 24 上で自動実行される。手動でしか埋まらないのは OS 差（macOS）と実ブラウザの有無なので、その 2 点に絞って **Node 24 系（v24.15.0 相当）で 3 回**実施する。
  - DevTools の Network で、シャットダウン後の `/sse` 再試行が**最大 10 回で止まり無限に続かないこと**を目視する（「再試行が発生しない」ではない — 2 つのクライアント実装とも `onerror` で自前リトライするため再試行は必ず発生する）。
- **理由:** AC-10。元のハングはタイミング依存で自動テストでは再現できない（「調査結果」参照）。**本ステップは「直った証明」ではなく非退行確認と真因切り分けのための観測である。**

## 設計判断

詳細は `adr.md` を参照。

- **ADR-001** 構造対策（順序 + シャットダウンフラグ）とタイムアウトの二層構成。原因未特定のためタイムアウトを AC の保証、構造対策を再発防止として位置づける。予算ゼロ（`!(timeoutMs > 0)`）を「常にタイムアウト」と定義して AC-3 を自動検証可能にする。タイマーは `unref()` しない（3 周目に方針変更。観測性を優先）。`process.exit` は CLI 層に留める。
- **ADR-002** `server.close()` を**手順 1**（最初の操作）に置き、手順 2〜4 を個別に捕捉して失敗を配列に集める（1 件はそのまま throw / 2 件以上は `AggregateError`）。`closeIdleConnections()` は採用しない（Issue 修正案 3 の後半は順序変更で解消済み）。手順 4 が必要なのはアイドル接続のためではなく送信中の SSE を抱えた active ソケットのためである。
- **ADR-003** シャットダウン中フラグは `SseManager` のクロージャに持ち、`closeAll` を `shutdown` に終端化。二重チェック + 503。`stream.onAbort()` は `clients.add()` より前に登録し、`add` は `!closed` でガードする。`AbortSignal.any` によるマネージャ単位 abort は不採用。
- **ADR-004** `in` ナローイングをそのまま使う（**`isHttpServer` 型述語への置き換えは撤回**。手書きの型述語はコンパイラに検証されないため型安全性の後退になる）。
- **ADR-005** `ServerInstance` を `{ shutdown }` だけに絞る（`close` / `sseCloseAll` / `watcher` を削除）。
- **ADR-006** keep-alive の待機を手書き `sleep()` から `node:timers/promises` の中断可能タイマーに置き換える（abort リスナーリークの構造的解消）。fake timers で駆動できなくなるトレードオフと、それを回帰ガードに転用する設計。
- **ADR-007** CLI 側の観測性は「シグナル受信ログ 1 行」に留め、**stdio drain と打ち切り時の再 `closeAllConnections()` は採用しない**（いずれも 2 周目で撤回）。
- **ADR-008** シャットダウン予算の注入口は `shutdown()` の引数ではなく `startServer()` の第 2 引数（`StartServerOptions.shutdownTimeoutMs`）に置く。memo 化との契約矛盾が型のレベルで消える。
- **ADR-009** `shutdown()` の再入ガードを手順の同期性から独立させる（`Promise.withResolvers()` で memo を本体実行より前に公開する）。

## リスクと注意点

- **Issue 本文のレースは現行コードでは成立せず、真因は特定できていない。** 2 名のレビュアーが独立に検証して一致した確定事項である。本計画でも現行コードのまま実 SIGINT を送って再現を試みたが、SSE 接続を張った状態で 7〜73ms・exit code 0 で終了し、ハングは再現しなかった。**本計画の構造対策は「今ある不具合の修正」ではなく将来の脆さへの保険であり、要件充足を担っているのはタイムアウトのみ**である。この主従を PR 説明でも明示すること。
- **残る有力な変数は Node のバージョン差（報告者 v24.15.0 / 検証 v22.22.1）。** 次点で「SIGINT ハンドラがそもそも起動していなかった可能性」。前者は CI（Node 24 で `pnpm test`）+ ステップ 9 の macOS / 実ブラウザ確認、後者はステップ 5 のシグナル受信ログで切り分ける。どちらも潰れないまま警告ログが常時出るなら、別 Issue で追跡する。
- **タイムアウトが真の原因を隠しうる。** 構造対策で直ったのか、タイムアウトが毎回発火して救っているだけなのかは AC-3 の警告ログでしか区別できない。自動テストは「警告が出せること」と「正常系で偽陽性が出ないこと」を担保するが、実運用で警告が出るかどうかはステップ 9 の記録でしか分からない。必ず記録すること。
- **`logger.warn` が `process.exit(0)` で取りこぼされうる残存リスク（stdio drain を入れないという判断の裏側）。** 実測した事実は次のとおり。(a) 短い 1 行の stderr 書き込みは pipe 越しでも `process.exit(0)` の直前に書けば欠落しない。(b) 欠落するのは未 flush 出力が 64KB を超える場合のみ（200KB 書き込みで pipe は 65536 バイトで切断、ファイルリダイレクトは全量 200025 バイトが残る）。peek のシャットダウン経路で出力するのは数行なので (b) には該当しないが、**将来シャットダウン経路に大量出力を足した場合は警告が欠落しうる**。drain を足すと今度は uncaught EPIPE で exit code が 1 になる（実測）ため、drain 以外の手段（`logger.warn` を `process.exit` より前に呼ぶ順序の維持）で対処する。
- **`stream.write()` が永久 pending になる可能性。** Hono の `StreamingApi.write()` は例外を握りつぶすだけでなく、消費側が pull を止めた場合 `writer.write()` は reject ではなく**永久に pending** になりうる。その場合 `run()` の `finally { stream.close() }` が走らず、ストリームコールバックが返らない。ただしソケットは `closeAllConnections()` で destroy 済みなので `server.close()` は止まらない（1 周目のレビューの実験 C で確認済み）。事実として記録しておく。
- **タイムアウトによる打ち切りは「まだ生きているソケットがある状態での終了」を意味する。** peek は読み取り専用プレビューなので副作用は無いが、`process.exit(0)` に依存するため exit code は常に 0 になる（打ち切りでも失敗扱いにならない）。これは意図した挙動。打ち切り時に追加の後始末は行わない（ADR-007）。
- **打ち切り時の残存リソースはテストからも呼ばれる。** ポート自体は `server.close()` の呼び出し時点で解放されるため後続テストのポート衝突は起きない（1 周目に実測）。`src/server/index.test.ts` の `afterEach` は `await server?.shutdown().catch(() => {})` のままでよい（`shutdown()` が有界になったことで teardown が無限に待つ可能性はむしろ消える）。**ただし AC-3 のテストは `startServer(config, { shutdownTimeoutMs: 0 })` で予算ゼロのサーバーを作るため、そのケースだけは `shutdown()` が resolve した後も `closing` が未決着のまま残る。** テスト内で `await closing` 相当を待つ手段は無いので、`afterEach` で `shutdown()` を再度呼んでも memo 化により no-op である点を理解した上で、テスト末尾で SSE レスポンスの `body.cancel()` だけ行う。
- **`server.close()` を先に呼ぶ順序変更により、シャットダウン中の進行中リクエスト（`/api/content` 等）が中断される。** 従来もほぼ同時だったため実質的な差は無いが、意図的な選択であることを認識しておく。
- **タイムアウト値 2 秒の妥当性は環境依存。** `closeAllConnections()` の後は 1 ティックで解決するのが正常系なので過剰に長いが、低速環境で正常系を誤って打ち切らないためのマージン。短くしすぎると AC-3 の警告が偽陽性になる。
- **ADR-006 の副作用: 置き換え後は keep-alive ループを vitest の fake timers で進められなくなる**（`node:timers/promises` は fake timers に差し替えられないことを実測確認）。将来 keep-alive の周期挙動そのものをテストしたくなったら `createSseManager()` に間隔の注入口を開ける必要がある。本 Issue ではその要求が無いので開けない。**AC-8 のテストはこの非対称性に判別性を依存させていない**（3 周目で body 読み捨てを入れたため。fake timers に駆動される実装でも通る）ので、将来 vitest が `node:timers/promises` を駆動するようになっても false-red にはならない。
- **AC-8 のテストは fake timers に駆動されない実 30 秒タイマーを残しうる。** `delay()` は既定 `ref: true` なので、`finally` で `sse.shutdown()` を呼んで abort しないとテスト終了後もタイマーが残る（実測では vitest のワーカー終了で回収され実害は確認できなかったが、1 行で確実に消せるゴミなので消す）。
- **ステップ 4 / 7 の新規テストはタイミング依存になりやすい。** AC-7 の閾値 500ms は「per-client abort が効いていること」を検出するために意図的に厳しくしてある（実測 0ms vs 未解決 1000ms 超なので余裕は 2 桁ある）。CI で不安定になった場合も**閾値を数秒まで緩めてはならない** — keep-alive 間隔 30 秒より十分小さい範囲に留めること。プロセスレベルの AC-1 テストは `spawn` の起動コスト（実測 319ms）がかかるが、`testTimeout` 30000ms の枠内に十分収まる。
- **失敗が 2 件以上のとき、`shutdown()` の呼び出し側が受け取るのは元のエラーではなく `AggregateError` になる。** `src/index.ts` は `logger.error("Failed to shut down server:", e)` に渡すだけなので実害は無く、そもそも手順 2〜4 が throw する経路は現状のコードでは到達しない（失敗 1 件なら包まずそのまま throw するので、既存の見え方も変わらない）。
- **`ServerInstance` の型変更は破壊的変更に見えるが実際には非破壊。** package.json に `main` / `exports` が無く `bin` のみのため、この型を import する外部コンシューマは存在し得ない。ただしレビュー時に指摘されうるので理由を PR に書くこと。

## テスト方針

**自動テストで担保するもの**

| 対象 | AC | レイヤー | 検証内容 |
|---|---|---|---|
| プロセス終了性 | AC-1 | E2E（`src/index.shutdown-process.test.ts`、`spawn` + 実 SIGINT） | SSE 接続中に SIGINT を 1 回送って `Server stopped` が出力される / exit code 0 / 予算 2 秒未満 / タイムアウト警告なし。CI matrix により Node 22 / 24 の両方で実行される |
| `withTimeout` | AC-2, AC-3 | 単体（`src/lib/with-timeout.test.ts`） | 解決 / 永久保留時のタイムアウト解決 / 予算ゼロ・`NaN` の決定的タイムアウト / 予算内 reject の透過 / unhandled rejection なし / 期限内 settle 時にタイマーが残らない |
| タイムアウト警告 | AC-3 | 統合（`src/server/index.test.ts`、実ポート） | `startServer(config, { shutdownTimeoutMs: 0 })` で `console.warn` が発火 / 既定予算では発火しない |
| シャットダウン契約 | AC-4, AC-9 | 統合（`src/server/index.test.ts`、実ポート + `serve()` / `SseManager.shutdown()` / `createFileWatcher()` スタブ） | 呼び出し直後に新規接続を拒否 / 最初の `await` の前に `close` → `sse.shutdown` → `watcher.close` → `closeAllConnections` の順で 4 手順すべてが走る / 冪等 / 並行呼び出し |
| 手順ごとのエラー分離 | AC-11 | 統合（`src/server/index.test.ts`、同じスタブ） | 手順 2 / 3 / 4 のいずれが throw しても後続手順と有界待機が走る（`calls` の 4 要素 + 経過時間 + 警告 1 回）/ 失敗 1 件はそのまま throw / 2 件以上は `AggregateError` に両方載る |
| SSE シャットダウンフラグ | AC-5, AC-6 | 単体（`src/server/routes/sse.test.ts`、Hono `app.request`） | シャットダウン後の `/sse` が 503 かつストリーム未生成 / `clientCount` が増えない |
| per-client abort の維持 | AC-7 | 単体（`src/server/routes/sse.test.ts`） | `shutdown()` 後にレスポンス body が 500ms 以内に EOF（`done: true`）に達する |
| keep-alive の待機実装 | AC-8 | 単体（`src/server/routes/sse.test.ts`） | body を読み捨ててループを周回させても client 1 本あたりの abort リスナーが 1 個を超えない（手書き `sleep()` 再導入の回帰ガード）。**positive control（`clientCount === 1` / リスナー数 1 の実在）を必ず伴う** |

**間接検証にとどまるもの（明記事項）**

- **AC-2** は `shutdown()` 自体に「永久に解決しない `server.close()`」を注入するテストを持たない（実サーバーでその状況を作れないため）。担保は「`withTimeout` の単体テストが有限時間 settle を決定的に検証する」+「`shutdown()` の唯一の待機点が `withTimeout(closing, shutdownTimeoutMs)` であるというコード上の構成」の組み合わせである。後者はレビューで確認する。
- **`/sse` ハンドラの `stream.onAbort(cleanup)` 先行登録と `if (!closed) clients.add(client)` ガード**（実装レビュー 2 ラウンド目で追加）には自動テストが無い。**現行の Hono では到達不能**だからである（`onAbort` の登録から `add` までに `await` が無く、`StreamingApi.abort()` の唯一の到達経路である `responseReadable` の `cancel` はコールバックの同期部より後にしか走らない）。窓を作るには production 側に人工的な `await` を入れるしかなく、それは ADR-003 のフォールト注入（`add`→`onAbort` = 1 / `onAbort`→`add` = 1 / 採用形 = 0）で実測済みである。**テストを足さないことが妥当な箇所**であり、漏れではない。
- **AC-8** は「手書き `sleep()` に戻ると落ちる」「`/sse` ハンドラが keep-alive 待機に到達しないと落ちる」ことを保証するが、`node:timers/promises` 版で N 回正常完了してもリークしないことを実行時に確認しているわけではない（fake timers が `node:timers/promises` を駆動できないため、(a) のループは最初の待機で止まる）。後者は ADR-006 の直接実測（25 回完了で手書き 25 個 / 標準 API 0 個）で担保する。

**自動テストで担保できないもの（手動確認へ）**

- **元のハングそのものの再現。** 「調査結果」で示したとおり、Issue 記載のレースは現行コードでは成立せず、真の原因も特定できていないため、失敗するテストを先に書くことができない。代替として「close が永久に解決しない」状況を `withTimeout` の単体テストで直接注入し、AC-2 が満たされることを決定的に検証する。
- **実運用でタイムアウト警告が出るかどうか。** 自動テストは警告経路の存在と偽陽性の不在を担保するだけで、「実際に救われているのか」はステップ 9 の記録でしか分からない。
- **実ブラウザ 2 実装（`src/client/lib/sse.ts` / `src/server/renderer/html-document.tsx`）の再接続挙動。** ステップ 9 の手動確認で、DevTools の Network から `/sse` の再試行が最大 10 回で収束することを目視する。
- **macOS × Node 24 の組み合わせ。** CI は `ubuntu-latest` のみなので、OS 差はステップ 9 で埋める。

**回帰確認**

- `pnpm test` / `pnpm typecheck` / `pnpm lint:fix` / `pnpm format`（CLAUDE.md の Code Quality 手順）。
- `pnpm dev` で通常起動 → ファイル編集 → ライブリロードが動くこと（SSE 経路を壊していないこと）。

## レビュー履歴

### 1周目

**修正した点**:

- **[カバレッジ P-001 / アーキ P-003]** AC-5 の「ブラウザ `EventSource` が再接続ループに入らない」は事実として偽（2 つのクライアント実装とも `onerror` で自前リトライするため、503 でも 200 + 即クローズでも観測挙動は同一）。AC-5 を「シャットダウン開始後の `/sse` は SSE ストリームを一切開始せず 503 を返す」というサーバー側で検証可能な事実に書き換え、`clientCount` の話を AC-6 に分離した。503 採用理由を「意味論的に正しいステータスを in-flight リクエストに明示的に返す / ストリームを一切生成しない」に差し替え、再接続に関する記述の中心を「`server.close()` を冒頭で呼ぶため再接続試行は TCP レベルで失敗する」に据え直した（ADR-003 / 依存関係 / UI 節 / ステップ 9 の目視項目もあわせて修正）。
- **[カバレッジ P-002]** `src/server/renderer/html-document.tsx` を実際に読み、第 2 の SSE クライアント実装として関連ファイル表に追加。Issue 本文が引用している `var es = new EventSource("/sse");` がこちらのコードであることを明記し、スコープの「含まれないもの」を両実装を名指しする形に修正した。
- **[カバレッジ P-003]** AC ↔ ステップの紐づけを表全体で再点検し、AC 番号とステップ構成を作り直して整合させた。テスト方針の表にも AC 列を追加して対応を明示した。
- **[カバレッジ P-004]** プロセスレベルの受け入れ基準を AC-1 として新設（SIGINT 1 回で 5 秒以内・exit code 0）。Issue の唯一の要件がこれであることを「目的」節に明記し、`spawn` + 実 SIGINT による自動検証をステップに追加した。
- **[カバレッジ P-005]** AC-10（旧 AC-9）の閾値を `SHUTDOWN_TIMEOUT_MS = 2000` と整合する 5 秒（= タイムアウト値 + 実行オーバーヘッドの上限）に修正。あわせて「n=10 の成功は稀事象が直った証明にならない」という限界を AC 表の直下に明記し、AC-10 の役割を非退行確認と真因切り分けの観測に限定した。
- **[アーキ P-001]** AC-7（旧 AC-6）のテストを「`shutdown({ timeoutMs: 20_000 })` を注入した上で 500ms 未満に解決すること」に変更。閾値を既定タイムアウトより十分小さくすることで、タイムアウトに救われた場合にテストが落ちるようにした（**2 周目で再度作り直した** → 下記 2 周目 P-101）。
- **[アーキ P-002]** `node_modules/hono/dist/utils/stream.js` を読んで `StreamingApi.write()` が例外を握りつぶすことを確認。keep-alive 停止の「3 層」を「2 層（主: per-client abort / 副: `while (!closed)` ガード）」に訂正し、`stream.write(...).catch(cleanup)` はデッドコードとして**削除**（理由をコメントで残す）、`writeSSE(...).catch(cleanup)` は不正 `event` 名で実際に reject しうるため**残す**、と方針を明記した。`stream.write()` が永久 pending になりうる点も「リスクと注意点」に追記した。
- **[アーキ P-004]** `sleep()` の abort リスナーリークを本 Issue のスコープに追加。手書き `sleep()` を `node:timers/promises` の中断可能タイマーに置き換える方針（ADR-006）と、リークしないことを検証する単体テスト（AC-8）をステップに追加した（**テスト設計は 2 周目で作り直した** → 下記 2 周目 P-102）。

**取り込んだ改善提案**:

- **[カバレッジ S-001]** 型述語化を受け入れ基準から削除し、スコープの「含まれるもの（付随整理）」に降格。変更自体はステップに残した。
- **[カバレッジ S-002]** ADR-005 をスコープの「含まれるもの（付随整理）」に明記し、`sseCloseAll` の削除が ADR-003 の帰結、`close` の削除が誤用経路の除去であることを理由付きで書いた。
- **[カバレッジ S-003]** `broadcast()` の no-op ガードを削除（`clients.clear()` により既に no-op で挙動不変）。契約は `shutdown()` の doc コメントで示す方針にした。対応する追加テストも削除した。
- **[カバレッジ S-004]** 実装ステップを「グループ A: 要件充足」「グループ B: 再発防止・付随整理」の 2 群に分け、別コミットに分けられる並びにした。
- **[カバレッジ S-005]** ADR-002 に「Issue 修正案 3 の後半（close 完了までの間に張られた接続の破棄）は順序変更で解消済み。不採用なのは `closeIdleConnections()` の併用のみ」という段落を追加した。
- **[カバレッジ S-006]** AC-7 の由来を「回帰防止（既存の per-client abort の維持）」に修正。AC-4/5/6 の由来も「再発防止（Issue 修正案 1）」に改めた。
- **[カバレッジ S-007 / アーキ S-002]** `withTimeout` を `src/lib/` に置く根拠を「`timer.unref()` が Node 専用 API であり `src/core/` のランタイム非依存要件を満たさない」に差し替え。`src/lib/logger.ts` が `src/client/lib/sse.ts:7` から import されている事実を確認し、「`src/lib/` = サーバー専用 / `src/core/` = クライアントバンドルに入りうる層」という誤った根拠を撤回した。
- **[アーキ S-003]** ②の再チェック経路では 200 + `text/event-stream` + 即 EOF が返る点と、①の 503 との役割の違いを設計節と ADR-003 に明記した。
- **[アーキ S-004]** `process.exit(0)` による `logger.warn` の取りこぼし対策として、CLI に stdio drain を追加した（**2 周目で撤回** → 下記 2 周目 P-101）。
- **[アーキ S-005]** タイムアウト打ち切り時に `closeAllConnections()` を再度呼ぶ後始末を追加し、doc コメントに「タイムアウト時はソケットハンドルが残りうる／プロセス終了の責務は呼び出し側」と書く方針にした（**再呼び出しは 2 周目で撤回**、doc コメントは維持 → 下記 2 周目 S-103）。
- **[アーキ S-006]** ADR-005 の削除基準を「未使用**かつ**誤用で本 Issue のハングを再現できる」に明文化し、`watcher` を残すことと整合させた。
- **[アーキ S-007]** 「レースは成立しない」の根拠を Hono の実装詳細依存から「マイクロタスクは次のマクロタスクの前に必ず全て流れるので、2 つのマクロタスクが interleave しない」に差し替えた。
- **[アーキ S-008]** 手動確認に「報告者環境と同じ Node 24 系での実施」を追加した。
- **[アーキ S-009]** CLI の SIGINT/SIGTERM ハンドラにシグナル受信ログを追加した。

**見送った提案とその理由**:

- なし（1 周目の指摘・提案はすべて取り込んだ）。

### 2周目

**修正した点**:

- **[カバレッジ P-101]** AC-7 のテストが「`closeAllConnections()` に救われて絶対に落ちない」問題を修正した。`server.close()` の解決は keep-alive ループが抜けるかどうかに依存しないため、`shutdown()` の所要時間からは per-client abort の効果を原理的に観測できない。**検証層を `src/server/index.test.ts`（実ポート）から `src/server/routes/sse.test.ts`（Hono `app.request`）へ移し**、「`sse.shutdown()` 後にレスポンス body が 500ms 以内に EOF に達する」に書き換えた（`app.request` 経路にはソケットが無く、`closeAllConnections()` に救われる余地が構造的に無い）。**本計画で判別性を実測確認: 現行実装は 0ms で `done: true`、`abortController.abort()` を除去した複製実装は 1000ms 経っても `read()` が解決しない。** AC-7 の対応ステップを 6・7 に付け替え、`timeoutMs` の注入テストは AC-3 側（`timeoutMs: 0`）に移した。
- **[カバレッジ P-102 / アーキ P-102]** AC-8 のテストが `node:timers/promises` を直接叩くだけで `sse.ts` を 1 行も通らない問題を修正した。**2 レビュアーの相反する実測が両立するかを自分で検証した結果、両方とも正しかった**: (a) vitest の fake timers は `node:timers/promises` を差し替えない（アーキ側の主張。probe で `advanceTimersByTimeAsync(30_000)` 後も `delay(30_000)` は未解決）。(b) それでも「fake timers + `AbortController` スパイ」のテストは判別性を持つ（カバレッジ側の主張。**現行実装 max = 2 で fail / `node:timers/promises` 版 max = 1 で pass** を実測再現）。したがって **AC-8 は自動テストとして成立させた**（`createSseManager()` を経由し、手書き `sleep()` に戻ると必ず落ちる）。ただし green になる理由は「fixed 版では fake timers がループを進めないため待機が 1 個のまま」であり、**「N 回完了してもリークしない」ことの証明ではない**。この限界を AC 表の直下・ステップ 7・テスト方針の 3 箇所に明記し、リーク不在そのものは ADR-006 の直接実測（25 → 0、本計画で再現）で担保する形にした。`createSseManager()` への間隔注入口は本 Issue の要件と無関係な API 拡張なのでスコープ外とした。
- **[アーキ P-101]** stdio drain を計画から**削除**した。1 周目の改善提案（S-004）として入れたものだが、要件充足に寄与しないうえ AC-1（exit code 0）を壊すリスクを持ち込んでいた。**本計画で実測して確認: パイプの読み手が消えた状態で drain を `await` すると uncaught EPIPE で exit code が 0 → 1 に変わる（drain 無し exit 0 / drain 有り exit 1）。** しかも壊れるのは `peek . 2>&1 | tee log` という AC-3 の採取手順そのものである。**代替として、短い 1 行の書き込みは pipe 越しでも `process.exit(0)` 直前に書けば欠落しないことを実測で確認し**（欠落するのは未 flush 出力が 64KB を超える場合のみ。200KB 書き込みで pipe は 65536 バイトで切断、ファイルリダイレクトは全量が残る）、`logger.warn` を `process.exit(0)` より前に呼ぶ順序の維持だけにとどめた。残存リスクは「リスクと注意点」に実測値付きで 1 項目として記載した。これに伴い **アーキ S-105（「stderr が TTY でなければ非同期」の一般化しすぎ）も解消**（当該記述ごと削除し、実測した事実で置き換えた）。ステップ 4 は「CLI のシグナル受信ログ」だけになったのでグループ B に移し（**カバレッジ S-101**）、AC-1 の対応ステップから外した。ステップ全体を 1〜9 に振り直し、AC ↔ ステップの紐づけを全 10 行再点検した。

**取り込んだ改善提案**:

- **[アーキ S-101]** `withTimeout` で `timeoutMs <= 0` を「予算ゼロ = 常にタイムアウト」として executor 内で同期 resolve する特別扱いを入れ、**AC-3（タイムアウト時の `logger.warn`）を手動確認から自動テストに昇格させた**。本計画で実測確認: `timeoutMs: 0` の同期 resolve 版は実 `server.close()` を相手に 10/10、`process.nextTick` 解決の Promise を相手に 20/20 で `timed-out` を返す。さらに SSE 接続を張った実サーバーで「`timeoutMs: 0` → 警告あり 10/10」「既定 2000ms → 警告なし・completed 10/10」を実測し、偽陽性が無いことも確認した。これに伴い `timeoutMs` オプションのテスト利用先が AC-7 から AC-3 に移ったが、デッド API にならない点は変わらない。
- **[アーキ S-102]** シグナル受信ログの挿入位置を `console.log()`（空行）の**後**・`intro()` の前に変更した（前に置くと端末の `^C` エコーと同じ行に連結し、既存コードが `console.log()` で `^C` と `intro()` を分離している意図を壊すため）。
- **[アーキ S-103]** タイムアウト打ち切り時の再 `closeAllConnections()` を**計画から削除**した。手順 2 でリスニングハンドルを閉じているため手順 4 以降に新規ソケットは accept されず、destroy 済みソケットへの再 destroy は no-op なので、効く場面が構成上存在しない。「無害な保険」として残すと将来の読者を誤らせるため削除を選んだ。doc コメントの「タイムアウト時はソケットハンドルが残りうる／プロセス終了の責務は呼び出し側」は維持する。
- **[アーキ S-104]** ステップ 9 に「グループ A 単独マージ時の最小手順」を定義した（起動 → タブ放置 → Ctrl+C を 3 回、終了時間と警告有無を記録）。グループ A こそが要件充足を担うのに、それを検証する手動確認がグループ B の末尾にしか無いという逆転を解消した。
- **[カバレッジ S-102]** ステップ 4（旧 5）のプロセステストの運用詳細をすべて確定させた。**自分で実際に走らせて確認した実測値に基づく**: 起動コマンドは `process.execPath` + `--import ./src/loaders/css.mjs --import tsx/esm`（実測 起動 319ms / SIGINT→close 7ms / exit 0。`node_modules/.bin/tsx` 経由も動作するが実測 496ms / 73ms でラッパーを挟むぶん経路が複雑なので不採用）、起動検出は `fetch("/")` が 200 を返すまで 150ms 間隔・上限 20 秒のポーリング（stdout 文言には依存しない）、空きポートは既存 `getFreePort()` の複製、fixture は `mkdirSync` + `README.md` 1 つ、後始末は 10 秒タイムアウト + `SIGKILL` + `body.cancel()`、ビルド成果物は `pretest` が生成するため追加要件なし。
- **[カバレッジ S-103]** `.github/workflows/ci.yml` を読み、**PR ごとに `ubuntu-latest` × Node 22 / 24 の matrix で `pnpm test` が回る**事実を「関連ファイル」表と「調査結果」に明記した。これによりステップ 4 のプロセスレベル終了性テスト（AC-1）は Node 24 上でも自動実行されるため、ステップ 9 の Node 24 手動確認を「macOS × 実ブラウザ × 実 Ctrl+C」の 3 回に限定して負担を減らした。
- **[カバレッジ S-104]** AC-2 が間接検証であること（`withTimeout` 単体テスト + `shutdown()` の唯一の待機点がそれを使うというコード上の構成の組み合わせ）を AC 表とテスト方針の「間接検証にとどまるもの」節に明記した。あわせて AC-8 の限界も同じ粒度で書いた。

**見送った提案とその理由**:

- **[アーキ S-102 後半]**（シグナル受信ログの増分価値は「どのシグナルか」の識別のみで、`intro(" Shutting down... ")` の表示有無だけで (i)/(ii) の切り分けは既に可能）— 行の削除は見送り、1 行のまま残した。SIGINT と SIGTERM を同じハンドラで受けている以上「どちらで起動したか」は Issue の観測（SIGTERM では即終了した）の解釈に直接効くため、真因未特定の間は識別できる価値がコスト（1 行）を上回ると判断した。ADR-007 の「真因判明後は削除を検討」という整理は維持する。

### 3周目

両レビュアーとも **Go**（実装フェーズへ進んでよい）。カバレッジ視点は「問題点ゼロ」、アーキ視点は問題点 1 件（P-201）。**指摘・提案は 6 件すべて取り込んだ。**

**修正した点**:

- **[アーキ P-201]** AC-8 のテストが **vacuous pass** する問題を修正した。旧スケッチのアサーションは `expect(Math.max(...counts)).toBeLessThanOrEqual(1)` のみで、`counts` には Hono 内部の `AbortController`（リスナー 0 個）が必ず混ざるため、**`/sse` ハンドラが keep-alive 待機に到達しない実装では `counts = [0, 0]` → `max = 0` で通過してしまう**。しかもその状態を作る変更（②の再チェック `if (shuttingDown) { cleanup(); return; }`）は同じステップ 6 に含まれている。**positive control**（`expect(signals.length).toBeGreaterThan(0)` / `expect(sse.clientCount).toBe(1)` / `expect(counts).toContain(1)`）をアサーションの直前に追加した。AC-8 の本文にも「positive control を必ず伴う」旨と、無い場合に何が起きるかを明記した。
- **[カバレッジ S-201 と統合して最終形を確定し、3 方向を実測]** 下記 S-201 の body 読み捨てと P-201 の positive control を**両方入れた最終形**を実際に書いて `vitest run` で走らせ、次の 3 点を確認した（5 tick、各 tick で全 signal の `abort` リスナー数を記録）。
  - **(a) 正しい実装（`node:timers/promises` 版）で pass**: 各 tick の最大リスナー数 `[1,1,1,1,1]` / `clientCount = 1` → **pass**。
  - **(b) 手書き `sleep()` に戻すと fail**: `[2,3,4,5,6]` / `clientCount = 1` → `expect(counts).toContain(1)` と `max <= 1` の**両方**で fail。
  - **(c) ハンドラが keep-alive 待機に到達しない実装（②の再チェックが常に真）でも fail**: `[0,0,0,0,0]` / `clientCount = 0` → `expect(sse.clientCount).toBe(1)` が捕捉して fail。
  - 旧スケッチ（positive control 無し・body 読み捨て無し）では (c) が **PASS** していた（レビュアーの実測を再現）。最終形はこれを塞いでいる。

**取り込んだ改善提案**:

- **[カバレッジ S-201]** AC-8 のテストで `/sse` のレスポンス body をバックグラウンドで読み捨てる 4 行を追加した。**4 実装 × body 読み捨ての有無 × 8 tick を実測してレビュアーの表を完全に再現した**（(a) `node:timers/promises` 版 `[1,1,...]`/`[1,1,...]`、(b) 手書きリークあり `[2,2,...]`/**`[2,3,4,5,6,7,8,9]`**、(c) 待機未到達 `[0,0,...]`/`[0,0,...]`、(d) 手書きだがリーク修正済み `[1,0,0,...]`/`[1,1,...]`）。これにより (i) 判別マージンが 1 → 8（5 tick なら 1 → 6）に広がって Hono の「書き込みを 1 件だけバッファする」挙動への依存が外れ、(ii) **fake timers に駆動される実装 (d) でも通る**ようになったため、ADR-006 の「fake timers の非対称性を回帰ガードに転用する」という依存が外れた。AC-8 の本文・「AC-8 が証明する範囲」の注記・設計節・テスト方針・リスク節・ADR-006 の該当記述をこの実測表で置き換えた。
- **[カバレッジ S-202]** AC-9 の「対応ステップ」列を `4, 7` → **`4, 7, 8`** に修正した（ステップ 8 が「AC-9 の既存テスト通過でカバーされる」と書いているのに AC 表から参照されていない片方向参照だった）。
- **[アーキ S-201]** `timer.unref()` を**採用しないことに方針変更した**（2 周目までは採用予定）。4 パターンを自分で実測した結果、(1) 2 周目に書いていた採用理由「unref しないとタイムアウト時間だけイベントループが生き延びテストの teardown が遅延する」は**偽**である（`promise` の settle 時に必ず `clearTimeout` するため。実測: `clearTimeout` あり・unref なしで **14ms** でプロセス終了 / `clearTimeout` を落とすと **303ms** 生き残る）、(2) 逆に unref には実害がある（未解決 Promise + 他に ref 付きハンドルが無い場合、**1ms でプロセスが自然終了して警告も `outro()` も `process.exit(0)` も走らない**。ref なら 306ms で警告が出る）、ことが確認できた。**テスト teardown への影響は無い** — `withTimeout` の全経路でタイマーは「張られない／クリアされる／発火して消費される」のいずれかであり、生き残る経路が存在しないため。設計節に実測表を追加し、ステップ 1・2 と ADR-001 を更新した。あわせて **`src/lib/` 配置の根拠が `unref()` に依存していた**ので、「タイマーという副作用をスケジュールするため純粋な層である `src/core/` には置かない」に差し替えた（`src/core/` の非テストファイルがタイマー・I/O・`console`・`process` を一切使っていないことを grep で実測確認）。
- **[アーキ S-202]** `withTimeout` の予算ゼロ判定を `timeoutMs <= 0` → **`!(timeoutMs > 0)`** に変更した。実測: `NaN <= 0` は **false** で `setTimeout(NaN)`（約 3ms 後に発火）に落ちるが、`!(NaN > 0)` は **true** なので `NaN` も予算ゼロに落ちる。ステップ 2 に `timeoutMs: NaN` のテストケースを 1 つ追加した。
- **[アーキ S-203]** 「executor 内で同期的に resolve する」という表現を、契約の記述としては **「`promise` の settle 順序と無関係に決定的に `timed-out` を返す」**に言い換えた（呼び出し側から見れば `await` は常に非同期で、「同期 resolve」は「同期関数として値が返る」と誤読されうる）。実装方法としての「executor 内で同期 resolve」は実装メモとして併記可、と明記した。
- **[アーキ S-204]** AC-8 テストの `finally` で `sse.shutdown()` を呼ぶことをスケッチと注記に追加した。`delay()` は既定 `ref: true` かつ fake timers に駆動されないため、テスト中に張られた 30 秒タイマーが実タイマーとして残る。`vi.useRealTimers()` / `globalThis.AbortController` の復元と同じ `finally` に置くことも明記した。リスク節にも 1 項目として追加した。

**見送った提案とその理由**:

- なし（3 周目の指摘・提案はすべて取り込んだ）。

**未解決事項**: なし。1〜3 周目の指摘・改善提案はすべて解消または取り込み済みで（各周の「見送った提案」はいずれも「なし」または理由付きで記録済み）、実装フェーズに持ち越す未解決の問題は無い。真因未特定という前提は「未解決の問題」ではなく計画の与件として全編で扱われており（ステップ 5 のシグナル受信ログ・ステップ 9 の観測記録・ADR-001 で追跡手段を用意済み）、要件充足はタイムアウトによる有界化が単独で担保する。

### 実装レビューでの変更

上の 1〜3 周目は**計画レビュー**（実装前）の記録である。実装後の PR レビュー 2 ラウンドで設計判断が変わった箇所を、本文に反映済みの内容として以下にまとめる。判断の根拠と却下した代替案は `adr.md` に記録してある。

**設計判断の変更**:

- **`server.close()` を手順 2 → 手順 1 に移した**（ADR-002 改訂）。旧順序は「再接続を誘発する操作より前にリスナーを止める」という自らの根拠と矛盾していた（手順 1 の `sse.shutdown()` こそが `onerror` → 自前リトライを誘発する操作）。Issue 本文の修正案 1 とも一致する形になった。
- **シャットダウン手順のエラー分離を追加した**（ADR-002 改訂）。手順 2 / 3 / 4 を `step()` で個別に捕捉し、手順 5 の予算内 reject も含めて `failures` 配列に集め、1 件はそのまま throw / 2 件以上は `AggregateError` にする。まとめて 1 つの `try` にすると手順 2 の throw が手順 4 を巻き添えにし、毎回予算をフルに使う（実測 2,003ms vs 1ms）。
- **`stream.onAbort()` を `clients.add()` より前に登録し、`add` に `!closed` ガードを付けた**（ADR-003 改訂）。「順序を入れ替えれば窓は消える」という当初の主張は誤りで、フォールト注入では順序変更だけだと死んだ client が `clients` に残った。2 つで 1 組。
- **型述語 `isHttpServer` への置き換えを撤回した**（ADR-004 改訂）。`in` はコンパイラが検証するナローイングであり、手書きの型述語（本体と述語の整合は未検証）への置き換えは型安全性の後退だった。「整理のつもりの変更が型安全性を下げるならやらない」という結論。
- **`ServerInstance` から `watcher` も削除した**（ADR-005 改訂）。`server.watcher.close()` を単独で呼ぶと「HTTP と SSE は生きたまま監視だけ死ぬ」不整合を作れるため、削除基準の後半を `close` / `sseCloseAll` と同じく満たす。`ServerInstance` は `{ shutdown }` の 1 メソッド型になった。
- **タイムアウト予算の注入口を `shutdown(options)` から `startServer(config, options)` に移した**（ADR-008 新設）。`shutdown()` は memo 化されるため「2 回目以降は無視される引数」という契約矛盾があり、予算は「インスタンスの寿命に対して 1 回だけ決まる値」なので生成時に受け取る形にすると矛盾が型のレベルで消える。**これに伴い AC-3 の文言を `startServer(config, { shutdownTimeoutMs: 0 })` に更新した。**
- **`shutdown()` の再入ガードを `Promise.withResolvers()` に変えた**（ADR-009 新設）。`shutdownPromise = (async () => {...})()` は代入が最初の `await` の後になるため、手順 1〜4 の実行中は memo が空だった。「同期実行だから安全」はこの PR が消そうとしている依存そのものなので、`shutdown()` 本体にも同じ基準を適用した。
- **`withTimeout` の配置根拠を撤回し、doc コメントから外した**（ADR-001 改訂）。「タイマーという副作用をスケジュールするから」も「`src/core/` はクライアントバンドルに入るから」も成立しない（後者は実測で反証済み）。正しい結論は「どちらでも壊れない」なので、コメントには ADR への参照 1 行だけを残す。あわせて reject 透過の契約を「予算内に reject した場合のみ」に精密化した。
- **手順 4（`closeAllConnections()`）が必要な理由を訂正した**（ADR-002 改訂）。「アイドルの keep-alive ソケットが残るから」ではない — Node 19 以降の `http.Server.prototype.close` は内部で `closeIdleConnections()` を呼ぶ。必要なのは送信中の SSE を抱えた active ソケットのためである。
- **`step()` のシグネチャを条件型にして非同期な手順を型で拒むようにした**（ADR-002 改訂、3 ラウンド目）。`run: () => void` は任意の戻り値を許すため、手順が async 化されても型が通ってしまい、失敗が `failures` に載らないまま unhandled rejection になる。ADR-009 の「コメントだけの不変条件は採らない」という基準を `step()` にも適用した。

**テストの変更**:

- **`src/server/shutdown-process.test.ts` を `src/index.shutdown-process.test.ts` に移動した**（テスト対象は CLI エントリであり、`src/lib/watcher.error-handling.test.ts` の aspect-suffix 前例と整合する）。
- **AC-1 テストの判別性を強化した**。exit code 0 と経過時間だけでは、永久に settle しない `shutdown()` でもイベントループ枯渇で Node が自分で exit 0 する（実測 6ms）ため判別できない。`Server stopped` の出力・予算 2 秒未満・`did not close within` を含まないこと、の 3 点を追加した。起動待ちのポーリングにも子プロセスの死亡検出と `AbortSignal.timeout` を足した。
- **AC-4 に手順順序テストを追加した**。手順 1〜4 はすべて同期なので実ソケット越しでは順序を観測できない。`serve()` / `SseManager.shutdown()` / `createFileWatcher()` をスタブして `["close", "sse.shutdown", "watcher.close", "closeAllConnections"]` を `shutdown()` の直後に同期的に読む形にした。
- **AC-11（手順ごとのエラー分離）を新設し、回帰ガード 3 ケースを追加した**。2 ラウンド目のレビューで「R1 で足した安全機構に回帰ガードが 1 つも無い（try/catch を外しても rethrow を消しても全 PASS）」と実測で指摘されたため。判別線は `calls` の並びだけでなく**経過時間**にもある（失敗の throw を手順 5 の前に移す変異は `calls` では捕まらず `elapsedMs >= 25` だけが捕捉する）。
- **手順 3（`watcher.close()`）を回帰ガードに載せた**（3 ラウンド目）。それまで `calls` の `toEqual` は 4 手順のうち 3 手順しか固定しておらず、**手順 3 を削除しても全テストが通っていた**。`createFileWatcher()` のスタブを 1 つ足して `calls` に `watcher.close` を記録し、エラー注入口（`onWatcherClose`）も開けた（実運用で最も throw しうるのは `fs.FSWatcher` の close なのに、注入口が手順 2 / 4 にしか無かった）。
- **AC-8 テストの body 読み捨てを fail-fast にした**（`if (reader)` だと reader が無いとき黙って判別マージンの無い旧形に退化する）。
