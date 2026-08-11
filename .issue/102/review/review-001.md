# PR Review #001 — fix: Ctrl+C でのシャットダウンを有界化し SSE のレースを構造的に塞ぐ

**PR:** #116
**Date:** 2026-07-25
**Round:** 1回目

## Summary

- Blockers: 2
- Warnings: 22
- Notes: 29
- Verdict: **BLOCKED**

## レイヤー別ファイル

- Concurrency & Lifecycle: review-001-concurrency-lifecycle.md（B: 0 / W: 6）— APPROVED
- Test: review-001-test.md（B: 1 / W: 4）— BLOCKED
- Architecture & Type Safety: review-001-arch-typesafety.md（B: 1 / W: 8）— BLOCKED
- Requirements & Regression: review-001-requirements-regression.md（B: 0 / W: 4）— APPROVED

## 指摘一覧

### Blockers

- [B-001] AC-1 のプロセステストが `shutdown()` 無限ハング時も PASS する — `src/server/shutdown-process.test.ts:108`（Test）
- [B-001] `isHttpServer` 型述語はコンパイラ未検証のアサーションで、置き換え前の `in` ナローイングより型安全性が下がっている — `src/server/index.ts:68`（Arch）

### Warnings

- [W-001] `shutdown()` の手順順序がコメントの根拠と不一致／手順間のエラー分離なし — `src/server/index.ts:225`（Concurrency）
- [W-002] `shutdownPromise` の代入が手順 1〜4 の後に完了するため、その間は再入ガードが無効 — `src/server/index.ts:222`（Concurrency）
- [W-003] `stream.onAbort()` が `clients.add()` より後 — `src/server/routes/sse.ts:73`（Concurrency）
- [W-004] ②の再チェック分岐のコメントに事実誤り（「the response was already handed back」）／到達不能な旨が未記載 — `src/server/routes/sse.ts:76`（Concurrency）
- [W-005] 手順 4 のコメント根拠が Node 19+ の実装と食い違う — `src/server/index.ts:232`（Concurrency）
- [W-006] テストが `shutting` を await 跨ぎでフローティングにしている — `src/server/index.test.ts:105`（Concurrency）
- [W-001] `clearTimeout` を両方削除しても with-timeout の 7 ケース全 PASS — `src/lib/with-timeout.test.ts:22`（Test）
- [W-002] ADR-002 の順序に回帰ガードが皆無／AC-4 の判別窓が 0〜10ms — `src/server/index.test.ts:100`（Test）
- [W-003] AC-8 の body 読み捨てが `if (reader)` 内で、`res.body` が null だと無言で退化 — `src/server/routes/sse.test.ts:170`（Test）
- [W-004] `getFreePort()` の TOCTOU 衝突が「起動しなかった」に化けて原因が読めない — `src/server/shutdown-process.test.ts:13`（Test）
- [W-001] `withTimeout` の doc が reject 透過を無条件に書いているが、タイムアウト後・予算ゼロでは reject が消える — `src/lib/with-timeout.ts:18`（Arch）
- [W-002] `src/lib/` 配置の根拠が plan.md 内部で不整合 — `src/lib/with-timeout.ts:1`（Arch）
- [W-003] `shutdown(options?: { timeoutMs })` はテスト注入専用の API 拡張で memo 化と契約が矛盾 — `src/server/index.ts:47`（Arch）
- [W-004] ADR-005 の削除基準が `watcher` に一貫適用されていない — `src/server/index.ts:46`（Arch）
- [W-005] `SseManager.shutdown` の doc 参照先に doc が無い — `src/server/routes/sse.ts:13`（Arch）
- [W-006] `withTimeout` の doc コメント（32 行）が実装（26 行）より長い — `src/lib/with-timeout.ts:1`（Arch）
- [W-007] CLI の正常系出力に `logger.info` を混ぜており既存規約と不一致 — `src/index.ts:182`（Arch）
- [W-008] CLI を spawn するテストがサーバー層ディレクトリに置かれている — `src/server/shutdown-process.test.ts:59`（Arch）
- [W-001] AC-10（手動確認 10 回と記録）が未実施 — `.issue/102/plan.md`（Requirements）
- [W-002] タイムアウト警告が clack の枠内に割り込み、testing.md の期待と衝突 — `src/server/index.ts:240`（Requirements）
- [W-003] testing.md エッジケース 1（Ctrl+C 2 回 → force exit）が実装後は通常再現しない — `.issue/102/testing.md:177`（Requirements）
- [W-004] 終了性テストが `bin` の実体 `dist/index.mjs` を一度も起動しない — `src/server/shutdown-process.test.ts:59`（Requirements）

## 仕分け結果

- fix: 22 件
- wont-fix: 3 件（`src/index.ts` の診断ログ、`dist/index.mjs` 未起動、AC-10 未実施）
- defer: 0 件

詳細は `triage.md` を参照。

## 特筆事項

- 4 レビュアーが並列でフォールト注入（実装をわざと壊して判別性を確認する）を実施したため、作業ツリーが一時的に相互汚染した。ラウンド終了時に `git status` / `git diff HEAD` で残骸ゼロを確認済み。次ラウンド以降は注入検証を行うレビュアーに worktree の使用を明示的に指示する。
- Concurrency レビュアーがハング注入版の実 CLI で AC-1 / AC-2 を end-to-end 実測（2009ms / exit 0 + 警告出力）。計画が「間接検証のみ」としていた穴が埋まった。
