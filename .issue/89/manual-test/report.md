# ブラウザ検証レポート — Issue #89: ファイルツリーの折りたたみ状態を永続化する

**実行**: manual-test スキル（agent-browser 0.27.0）
**サーバー**: http://localhost:3000（本番ビルド `node dist/index.mjs`）
**結果**: 7 件すべて PASS（FAIL 0 / 起票 Issue なし）

## 検証範囲

testing.md の確認項目（正常系5＋異常系2）をすべて自動実行。ネスト構造を持つテスト用ディレクトリ `/tmp/peek-test-89` と、名前空間分離確認用の別ディレクトリ `/tmp/peek-test-89-other` を用意して検証した。

## 結果

| TC | 内容 | 結果 |
|----|------|------|
| TC-001 | 開閉→リロードで復元 | PASS |
| TC-002 | 別ディレクトリで状態が混ざらない（別 projectId） | PASS |
| TC-002b | 2 projectId 共存・相互不干渉（サーバー再起動を挟んで実観測） | PASS |
| TC-003 | SSR 初期描画整合（ハイドレーション警告/ちらつき無し） | PASS |
| TC-004 | SSE ツリー更新後も開閉維持・新規は展開 | PASS |
| TC-EDGE-1 | localStorage 破損でもクラッシュせず全展開 | PASS |
| TC-EDGE-2 | TTL 30日超過エントリのパージ | PASS |

詳細は `results/TC-*.md`、スクリーンショットは `screenshots/` 配下を参照。

## 所見

- 計画 plan.md / adr.md の設計（collapsed 集合・projectId 名前空間化・useLayoutEffect 復元・TTL パージ）が実機で意図通り動作することを確認。
- ハイドレーション不一致は発生せず、SSR 整合の設計が有効。
- localStorage の堅牢性（破損 JSON の握りつぶし＋自己修復）も確認。

## スコープ外で気づいた既存の問題（Issue #89 とは無関係）

1. `pnpm dev:server` 単体起動が `src/styles/content.css?inline` を css loader（`src/loaders/css.mjs`）が処理できず `ERR_UNKNOWN_FILE_EXTENSION` でクラッシュする。loader は `url.endsWith(".css")` で判定しており `?inline` 付き URL にマッチしない。
2. `package.json` の `start` スクリプトは `node dist/index.js` だが、tsdown のビルド出力は `dist/index.mjs`（bin と一致）。`dist/index.js` は生成されないため `pnpm start` は動かない可能性が高い。

→ Phase 4 でスコープ外 Issue として扱う。
