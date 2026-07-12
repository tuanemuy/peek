# PR Review #002 — feat: persist file tree collapse state in localStorage (#89)

**PR:** #94
**Date:** 2026-06-07
**Round:** 2回目（修正後の再レビュー）

---

## Summary

- Blockers: 0
- Warnings: 0
- Notes: 修正の妥当性を確認
- Verdict: **APPROVED**

---

## Frontend (Round 2)

### Blockers
- なし

### Warnings
- なし

### Notes
- W-001 修正は正しい。`toggle` は `next` を updater 外で計算し `setCollapsed(next)` を値渡し、localStorage 副作用は updater 外で実行。updater は純粋。
- `collapsedRef.current = collapsed` の同期は既存 `directory-app.tsx` の `currentPathRef` と同パターン。同一ティック内の連続 toggle も ref を介して正しく積み上がり取りこぼし無し。
- 復元 useLayoutEffect 後も collapsedRef が state に追従し整合。clobber 回避（readStore で最新読み直し）・try/catch ガードも維持。
- isOpen の依存・再描画トリガー、SSR/ハイドレーション整合に退行なし。

## Client Logic & Test (Round 2)

### Blockers
- なし

### Warnings
- なし

### Notes
- W-002 修正は正しい。`parseStore` がトップレベル（null/配列/プリミティブ）とエントリ単位（非object、lastAccess 非number、collapsed 非配列、collapsed 内非文字列）を防御的に検証し、不正を drop。純粋・不変性を維持。
- 全重点ケース（`parseStore("null")`→{}、配列/プリミティブ→{}、各種不正エントリ drop、非文字列要素除外）が意図通り。
- NaN/Infinity lastAccess は localStorage(JSON)経由では到達不能、仮に到達しても purgeExpired で安全に除去。実用上の穴なし。
- W-003 追加6テストは過不足なく正しいアサーション（混在ケースで drop＋保持を同時検証）。
- downstream（getCollapsedSet/purgeExpired/writeCollapsed）が整形済みデータのみ受け取る前提となり型・実行時とも安全。退行なし（241テスト pass, typecheck/lint クリーン）。

---

## Design Decisions

- 見送り済み（Round 1 で記録）: purge-on-toggle 省略（plan 設計通り）、ハッシュ salt 無し（ADR-001 に脅威モデル注記済み）。
- 1ラウンドクリーン（Round 2 で Blocker/Warning ともゼロ）につきレビュー完了。
