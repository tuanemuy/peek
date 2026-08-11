# PR Review #002 — fix: Ctrl+C でのシャットダウンを有界化し SSE のレースを構造的に塞ぐ

**PR:** #116
**Date:** 2026-07-25
**Round:** 2回目

## Summary

- Blockers: 0
- Warnings: 13
- Notes: 29
- Verdict: **APPROVED**（ただし fix と仕分けた指摘が 13 件あるため、修正して 3 ラウンド目へ）

## レイヤー別ファイル

- Concurrency & Lifecycle: review-002-concurrency-lifecycle.md（B: 0 / W: 2）— APPROVED
- Test: review-002-test.md（B: 0 / W: 2）— APPROVED
- Architecture & Type Safety: review-002-arch-typesafety.md（B: 0 / W: 6）— APPROVED
- Requirements & Regression: review-002-requirements-regression.md（B: 0 / W: 3）— APPROVED

## 1ラウンド目指摘の解消状況

- Concurrency: W-001 / W-002 / W-004 / W-005 / W-006 解消、**W-003（`onAbort` 順序）部分的** → 本ラウンド W-001 に継続
- Test: B-001 / W-001〜W-004 の 5 件すべて解消（各々を変異注入で FAIL することを実測確認）
- Arch: B-001 / W-003 / W-004 / W-005 / W-006 / W-008 解消、**W-002（`src/lib/` 配置根拠）部分的** → 本ラウンド W-002 に継続、W-007 は wont-fix 継続
- Requirements: W-002 / W-003 解消（testing.md 修正）、W-001 / W-004 は wont-fix 継続

## 指摘一覧

### Concurrency & Lifecycle

- [W-001] `onAbort` を `clients.add` の前に移しても「client が `clients` に残り続ける」窓は塞がっていない／コメントの主張が事実と不一致 — `src/server/routes/sse.ts:75`
- [W-002] 手順 2〜4 を単一 `try` にまとめたため、手順 2 の throw が `closeAllConnections()` を巻き添えにし、毎回タイムアウト予算をフル消費する — `src/server/index.ts:224`

### Test

- [W-001] 1 ラウンド目で追加した「手順 2〜4 のエラー分離」に回帰ガードが 1 つも無い（try/catch を外しても rethrow を消しても 268 全 PASS） — `src/server/index.test.ts`
- [W-002] `src/index.shutdown-process.test.ts` の内部予算 20s + 10s = 30s が `testTimeout: 30000` と一致し余裕ゼロ。vitest タイムアウトが先に発火すると `finally` の SIGKILL が走らず子プロセスが孤児になる — `src/index.shutdown-process.test.ts`

### Architecture & Type Safety

- [W-001] エラー分離の失敗チャネルが 1 本しかなく、手順 2〜4 のエラーが `closing` の reject に上書きされて無言で消える。ADR-002 の「エラーは必ず届く」が無条件には成立しない — `src/server/index.ts`
- [W-002] `src/lib/` 配置根拠が**事実として誤った基準**に置き換わった（クライアントバンドルは `entry.tsx` から esbuild `bundle: true` なので import 到達可能なものしか入らない。実測で `src/core/path.ts` 等がバンドルに含まれないことを確認） — `src/lib/with-timeout.ts:1`
- [W-003] `StartServerOptions.shutdownTimeoutMs` の doc に `0` / `NaN` が「即諦めて警告」を意味することが書かれていない — `src/server/index.ts`
- [W-004] コメント総量が増加（3 ファイル計 80 → 98 行、main 時点は 2 行）。PR 自身の物語や ADR の丸写しが混ざっている — `src/server/index.ts:261` / `src/server/routes/sse.ts:81`
- [W-005] ADR 内に改訂前の手順番号「手順 2」が 4 箇所残存 — `.issue/102/adr.md:169,212,454,458`
- [W-006] `plan.md` が 2 ラウンド目でまったく更新されておらず実装と矛盾（型述語化 4 箇所・「watcher は残す」2 箇所・ADR 一覧に ADR-008/009 なし） — `.issue/102/plan.md`

### Requirements & Regression

- [W-101] PR 本文が 1 ラウンド目の修正を一切反映しておらず、事実と異なる記述 6 件・記述漏れ 3 件がある — PR #116 本文
- [W-102] `testing.md` の「リスニングハンドルは手順 2 の時点で閉じている」が手順 1 に／ビルドサイズ 128.39 kB が実測 130.90 kB — `.issue/102/testing.md:23,240`
- [W-103] `plan.md` の AC-3 が存在しない API `shutdown({ timeoutMs: 0 })` を指したまま — `.issue/102/plan.md:25` 他

## 仕分け結果

- fix: 13 件（全件）
- wont-fix: 0 件（1 ラウンド目の 3 件は継続）
- defer: 0 件

詳細は `triage.md` を参照。

## 特筆事項

- 今回は全レビュアーが git worktree でフォールト注入を隔離したため、メインの作業ツリーの相互汚染はゼロだった。
- Concurrency レビュアーが `Promise.withResolvers` を **engines 下限の Node 22.0.0 実バイナリ**で検証（利用可）。Requirements レビュアーは Node 22.0.0 導入とちょうど一致することを確認。
- Requirements レビュアーが rethrow 経路を実注入で検証し、手順 2〜4 が throw しても実 CLI が exit 0 に到達することを実測（3/3、40〜49ms）。手順 2〜4 を丸ごと飛ばして SSE を生かしたまま SIGINT した場合も exit 0 / 2090ms + タイムアウト警告で終了。
- Blocker はゼロで、残る 13 件はいずれも「正確性の詰め」と「ドキュメント追随」。実装の骨格は 2 ラウンドで固まったと判断する。
