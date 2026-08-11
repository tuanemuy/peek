# PR Review #003 — fix: Ctrl+C でのシャットダウンを有界化し SSE のレースを構造的に塞ぐ

**PR:** #116
**Date:** 2026-07-25
**Round:** 3回目

## Summary

- Blockers: 0
- Warnings: 4
- Notes: 27
- Verdict: **APPROVED**（fix と仕分けた指摘が 5 件あるため、修正して 4 ラウンド目へ）

## レイヤー別ファイル

- Concurrency & Lifecycle: review-003-concurrency-lifecycle.md（B: 0 / W: 0）— APPROVED
- Test: review-003-test.md（B: 0 / W: 1）— APPROVED
- Architecture & Type Safety: review-003-arch-typesafety.md（B: 0 / W: 2）— APPROVED
- Requirements & Regression: review-003-requirements-regression.md（B: 0 / W: 1）— APPROVED

## 2ラウンド目指摘の解消状況

- Concurrency: W-001 / W-002 とも解消（`clientCount` が 0 に戻ることを対照実験で実測、手順 2 throw のシナリオが 2024ms + 誤警告 → 8ms + 警告なしに改善）
- Test: W-001 / W-002 とも解消（R2 で「268 passed で通る」と実測した 2 変異が 3 failed で落ちる、`afterEach` の SIGKILL を潰した対照実験で孤児化の有無を確認）
- Arch: W-001〜W-006 の 6 件すべて解消
- Requirements: W-101 / W-102 / W-103 の 3 件すべて解消（PR 本文の事実誤り 6 件・記述漏れ 3 件を 1 件ずつ実装と突き合わせて一致を確認）

## 指摘一覧

- [W-001] シャットダウン手順 3（`watcher.close()`）だけが両方向で無検証（削除しても 271 passed）。`withStubbedServer` の docstring も事実と不一致 — `src/server/index.test.ts`（Test）
- [W-001] `step(run: () => void)` が非同期な手順を型で拒めない。将来どれかの手順が `Promise<void>` を返すと、失敗が `failures` に載らず unhandled rejection でクラッシュする — `src/server/index.ts`（Arch）
- [W-002] `src/index.ts:186-189` の「この文字列をテストが assert している」コメント 4 行がテスト側の劣化コピー — `src/index.ts:186`（Arch）
- [W-001] `testing.md` 項目 4 の「2 分間観察」では期待結果「再接続は最大 10 回で停止」を確認できない（実際は約 181 秒後） — `.issue/102/testing.md`（Requirements）
- [N-002] `plan.md` が 3 ラウンド目の追加に未追随（テスト方針表・順序テストの期待値・`shutdown error isolation` の記載なし） — `.issue/102/plan.md`（Test の Note だが fix する）

## 仕分け結果

- fix: 5 件（Warning 4 件 + Test N-002）
- wont-fix: 0 件（既存の 3 件は継続）
- defer: 0 件

いずれも数行〜十数行の修正で、設計判断には波及しない。詳細は `triage.md` を参照。

## 特筆事項

- **Concurrency 観点は Warning ゼロに到達。** 実 CLI に対する 6 種のフォールト注入で全パターン exit 0、AC-4 は 6 パターンすべてで `ECONNREFUSED`、`AggregateError` は `util.inspect` が `[errors]` を展開するため CLI に届いてもユーザーが原因を追えることを実測確認。
- **判別性で捕捉できなかった変異は 3 件のみ**（手順 3 の削除 = 本ラウンドで修正、`!closed` 除去と `onAbort` 後置 = Hono の `StreamingApi` を読んで構造的に到達不能と確認済みでテスト不能）。
- Test レビュアーが `--sequence.shuffle` での失敗を検出したが、**PR 対象外の `src/lib/markdown.test.ts` / `src/lib/styles.test.ts` の既存 order dependence** で、単独でも再現する。本 PR が触った 2 ファイルは shuffle 各 10 回で全 pass。→ Phase 5 のスコープ外 Issue 候補。
- Arch レビュアーがコメント 89 行を comment-cleanup 基準で分類: ドキュメンテーション 29 行 / why・why-not 59 行 / 自明な言い換え 1 行（`main` 由来）、経緯・メタデータ 0 行。Phase 6 で消えるべきは Arch W-002 の 4 行だけと評価。
- Requirements レビュアーが merge-base を別 worktree で実測し、PR 本文の「+2 files / +20 tests」が正確であることを確認。
