# ブラウザ検証レポート — Issue #88: ファイル・ディレクトリの検索機能

**実行日**: 2026-06-07
**テストソース**: .issue/88/testing.md
**サーバー**: http://localhost:3000（`pnpm dev:server /tmp/peek-issue88-seed --port 3000 --no-open`）
**クライアントバンドル**: `pnpm build:css` + `pnpm build:client` 実行済み（変更を反映）

## 結果

**8 件中 8 件 PASS（FAIL: 0）。console エラー・hydration mismatch なし。**

| TC | テスト名 | 結果 | スクリーンショット |
|----|---------|------|------------------|
| TC-01 | 検索ボックスの表示 | PASS | screenshots/step-01.png |
| TC-02 | キーワードフィルタ（大文字小文字無視） | PASS | screenshots/tc-02-lower.png, tc-02-upper.png |
| TC-03 | マッチノードの親パス保持（全展開） | PASS | screenshots/tc-03.png |
| TC-04 | 「No matches found」表示 | PASS | screenshots/tc-04.png |
| TC-05 | `/` キーでフォーカス | PASS | screenshots/tc-05.png |
| TC-06 | 入力中の `/` を奪わない | PASS | - |
| TC-07 | 検索クリアで全ツリー復帰 | PASS | screenshots/tc-07.png |
| TC-08 | 既存ナビ（折りたたみ・プレビュー）健在 | PASS | screenshots/tc-08.png |

## 受け入れ条件の充足

- [x] サイドバーに検索ボックスが表示される（TC-01）
- [x] キーワードでファイル・ディレクトリをフィルタできる（TC-02）
- [x] マッチしたノードの親パスが維持される（TC-03）
- [x] 該当なしの状態が分かる（TC-04）
- [x] 既存のファイルツリー表示・ナビゲーションを壊さない（TC-07, TC-08, hydration なし）
- [x] テストを追加する（src/core/file-tree.test.ts — 8 ケース）
- [x] `/` ショートカット（TC-05, TC-06）

## 備考

- agent-browser 0.27.0 の `viewport` コマンド・`:has-text()` セレクタは本バージョン未対応だったが、既定 viewport 1280px でサイドバーは初めから表示され、`@ref`/`eval` で代替でき検証に影響なし（agent-browser の仕様であり機能バグではない）。
- 起票したIssue: なし（全PASS）。
- シードディレクトリ `/tmp/peek-issue88-seed` は検証後そのまま（一時ディレクトリ）。サーバー・ブラウザセッションは停止・クローズ済み。
