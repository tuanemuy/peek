# テスト実行サマリー — Issue #89

**テストソース**: .issue/89/testing.md
**サーバー**: http://localhost:3000（peek, directory モード, 本番ビルド dist/index.mjs）
**検証ディレクトリ**: /tmp/peek-test-89（ネスト構造）, /tmp/peek-test-89-other（名前空間分離用）

| TC | テスト名 | 種別 | 結果 | 失敗ステップ |
|----|---------|------|------|-------------|
| TC-001 | 開閉状態がリロードで復元される | 正常系 | PASS | - |
| TC-002 | プロジェクト間で状態が衝突しない（名前空間化） | 正常系 | PASS | - |
| TC-002b | 2つの projectId が共存し相互不干渉 | 正常系 | PASS | - |
| TC-003 | SSR 初期描画の整合（ちらつき/警告無し） | 正常系 | PASS | - |
| TC-004 | SSE ツリー更新時に開閉状態が維持される | 正常系 | PASS | - |
| TC-EDGE-1 | localStorage 破損でもクラッシュしない | 異常系 | PASS | - |
| TC-EDGE-2 | TTL パージ | 異常系 | PASS | - |

**合計**: 7 件（PASS: 7 / FAIL: 0）

## 主要観測
- projectId はパスのハッシュ（peek-test-89=`331492d18f68dc3f`, other=`156678d1520e429e`）。別ディレクトリで別キーになり名前空間が分離される。
- 折りたたみは collapsed（閉じている相対パス集合）に保存、デフォルト全展開。初回訪問でも空エントリ＋lastAccess が生成（仕様通り）。
- リロード/再訪で開閉状態を復元。SSE ツリー差し替え後も collapsed を維持。新規ディレクトリはデフォルト展開。
- ハイドレーション不一致警告なし。破損 JSON で全展開フォールバック＆自己修復。
- TTL 30日超過の偽エントリはリロード時にパージ、現プロジェクトは保持＋lastAccess 更新。
- 2 projectId が単一キー内に共存し、一方の折りたたみ操作が他方を変更しないことを実観測。

## 環境メモ
- `pnpm dev:server` は `content.css?inline` を css loader が処理できずエラーになるため（Issue #89 とは無関係の既存問題）、本番ビルド `pnpm build` → `node dist/index.mjs <dir>` で検証した。
- `package.json` の `start` スクリプトは `node dist/index.js` だが、tsdown の出力は `dist/index.mjs`（bin と一致）。`dist/index.js` は存在しない。
