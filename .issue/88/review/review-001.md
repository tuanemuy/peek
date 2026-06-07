# PR Review #001 — feat: ファイルツリーに検索（フィルタ）機能を追加

**PR:** #97
**Date:** 2026-06-07
**Round:** 1回目

---

## Summary

- Blockers: 0
- Warnings: 6（Frontend 3 / Core 2 / Test 2 ※Core W-002 は対応不要の注記）
- Notes: 多数（設計の妥当性を確認）
- Verdict: **BLOCKED**（Warning を可能な限り修正してから再レビュー）

---

## Frontend

### Blockers
なし

### Warnings
- **[W-001]** 検索 input にプログラム的な label がなく placeholder のみ（a11y）
  - 場所: `src/components/navigation/sidebar.tsx:54-63`
  - 理由: placeholder をラベル代替にするのは a11y アンチパターン。
  - 提案: `aria-label="Search files"` を付与する。 → **このPRで修正**
- **[W-002]** `/` フォーカス後に Escape で抜ける動線がない
  - 場所: `src/client/hooks/use-search-shortcut.ts`, `sidebar.tsx`
  - 理由: `/` で入りやすくした分、キーボードのみの離脱動線が弱い。
  - 提案: input の Escape で `setSearchQuery("")` + blur。 → **このPRで修正（小さく追加）**
- **[W-003]** サイドバー内縦レイアウトが `h-full` 依存のまま `flex-none` 兄弟（検索ボックス）が増えた
  - 場所: `src/components/navigation/sidebar.tsx:43,53,66`
  - 理由: header + 検索 + `h-full` で論理高さ超過の脆い構造。実害は出ていないが要素追加に弱い。
  - 提案: スクロール領域を `flex-1 min-h-0`、header/検索を `flex-none` に統一。 → **このPRで修正**

### Notes
- SSR/ハイドレーション整合が正しく担保されている（N-001）。
- 副作用管理が堅実（onBeforeFocus 参照安定・isComposing/editable 判定・cleanup）（N-002）。
- ADR-006 `useSidebar.open` 追加・ADR-005 `onToggle=undefined` は妥当（N-003, N-004）。
- presentational 純粋性・Tailwind 配色の一貫性が保たれている（N-005, N-006）。

## Core / ロジック

### Blockers
なし

### Warnings
- **[W-001]** 戻り値は入力ノードを共有しうる（case A は元ノード参照を再利用）。非破壊だが consumer が in-place 変更しない前提に依存。
  - 場所: `src/core/file-tree.ts:47`
  - 提案: ドキュメントコメントに「戻り値は入力ノードを共有しうる」を一言添える。 → **このPRで修正（コメント追記）**
- **[W-002]** `toLowerCase()` のロケール非依存性は正しい選択。Unicode 合字・正規化は実用上問題なし。 → **対応不要（注記のみ）**

### Notes
- アルゴリズム正当性が ADR-001〜003 と完全整合（N-001）。
- 純粋性・非破壊性・クライアントバンドル安全性・メタ文字安全性・パフォーマンス・型安全性すべて良好（N-002〜N-006）。

## Test

### Blockers
なし

### Warnings
- **[W-001]** 案A（ディレクトリ名マッチで配下全保持）の参照同一性を検証していない。
  - 場所: `src/core/file-tree.test.ts:62-75`
  - 提案: matched directory が元参照と同一であることを `toBe` で1行検証。 → **このPRで修正**
- **[W-002]** ディレクトリ脱落分岐（`filteredChildren.length > 0` が偽）の明示的テストがない。
  - 場所: `src/core/file-tree.test.ts:77-88`
  - 提案: 子が一切マッチしないディレクトリをフィクスチャに足し、脱落を直接固定する。 → **このPRで修正**

### Notes
- 主要分岐を網羅（空/空白/大小無視/ファイル・ディレクトリ・孫マッチ/0件/非破壊/順序）（N-001）。
- 受け入れ条件「テスト追加」を満たし、DOM テスト非追加の判断も妥当（N-002）。
- フィクスチャ妥当・アサーション厳密・既存規約と一貫（N-003〜N-006）。

---

## Design Decisions

このラウンドで新たな設計判断はなし（既存 ADR-001〜006 で網羅済み）。
