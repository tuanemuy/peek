# テスト実行サマリー — Issue #95

**実行日時**: 2026-06-07
**テストソース**: .issue/95/testing.md
**サーバー**: http://localhost:3000

| TC | テスト名 | 種別 | 結果 | 失敗ステップ |
|----|---------|------|------|-------------|
| TC-001 | `pnpm dev:server` がクラッシュせず起動し content.css が適用される | 正常系 | PASS | - |
| TC-002 | `start` スクリプトのパスが実ビルド出力（dist/index.mjs）と一致 | 正常系 | PASS | - |
| TC-003 | 本番ビルド経路（node dist/index.mjs）でプレビューが従来通り動く | 既存機能 | PASS | - |

**合計**: 3 件（PASS: 3 / FAIL: 0）

## 詳細

### TC-001
- `pnpm dev:server /tmp/peek-test95` が `ERR_UNKNOWN_FILE_EXTENSION` を出さずに起動（HTTP 200）。
- プレビュー画面に見出し「Hello」・strong「test」・ファイルツリー・パンくずが描画された。
- HTML に content.css（`.markdown-body`、line-height、max-width）が `<style>` として注入されていることを確認 → loader が `content.css?inline` を正しく処理している。
- スクリーンショット: `screenshots/tc-001/step-01.png`

### TC-002
- `pnpm build` の出力は `dist/index.mjs` のみ（`dist/index.js` は生成されない）。
- `package.json` の `start` = `node dist/index.mjs` で出力と一致。

### TC-003
- `node dist/index.mjs /tmp/peek-test95` が HTTP 200 で起動し、content.css 適用済みのプレビューを返した。本番経路に影響なし。
