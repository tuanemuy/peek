# PR Review #001 — fix: dev:server の起動エラーと start スクリプトのパス誤りを修正

**PR:** #96
**Date:** 2026-06-07
**Round:** 1回目

---

## Summary

- Blockers: 0
- Warnings: 0
- Notes: 7
- Verdict: **APPROVED**

---

## General Review

#### Blockers
- なし

#### Warnings
- なし

#### Notes
- **[N-001]** 両修正とも実機で検証済み。`pnpm dev:server` は `ERR_UNKNOWN_FILE_EXTENSION` を出さず起動し、`pnpm build` の出力は `dist/index.mjs` のみで `start: node dist/index.mjs` と一致。
- **[N-002]** クエリ除去ロジック（`src/loaders/css.mjs`）はエッジケースに対して妥当（`content.css?inline`→MATCH、クエリなし→挙動不変、`app.js?v=1`→誤マッチなし、自己 register の data: URL→誤マッチなし）。
- **[N-003]** `data:` URL 文字列内の構文の妥当性も問題なし。追加した `url.split("?")[0]` はバッククォートも `${}` も含まず、外側テンプレートリテラルのエスケープに影響しない。
- **[N-004]** `cleanUrl` が判定と読み込みの両方で一貫使用され、計画の設計判断と完全一致。`fileURLToPath` にクエリ付き URL を渡す不具合を正しく回避。
- **[N-005]** スコープ逸脱なし。コード変更は loader 1箇所と `start` 1行のみ。計画の「含まれるもの／含まれないもの」を厳守。
- **[N-006]** `src/server/renderer/document.tsx` の `global.css?inline` も同時に救済される。修正が汎用的にクエリ付き `.css` を扱える点は良い。
- **[N-007]** 本番経路への影響なし。本番ビルドは `@tsdown/css` が `?inline` を解決して `dist/index.mjs` にインライン化しており、loader 変更は無関係。

総評: 計画に忠実な最小修正で、エッジケース・副作用・本番影響のいずれも問題なし。マージ可能。

---

## Design Decisions

特になし。
