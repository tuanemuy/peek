# 動作確認計画 — Issue #95: 開発/ビルドツールの不整合

**Issue:** #95
**作成日:** 2026-06-07

---

## 確認環境

このIssueの変更を確認するために必要な手順のみ記載。

### 検証環境の起動

開発サーバー（修正対象その1）:

```bash
pnpm dev:server <プレビュー対象ディレクトリ>
```

`<プレビュー対象ディレクトリ>` には Markdown / HTML を含む任意のディレクトリを指定する（例: リポジトリルート `.` で README をプレビュー）。

### デプロイ方法

なし（ローカルの検証環境のみで確認できる）。

## 確認項目

### 1. `pnpm dev:server` がクラッシュせず起動する

- **目的:** css loader が `content.css?inline` を処理でき、`ERR_UNKNOWN_FILE_EXTENSION` が出ないことを確認する。
- **手順:**
  1. `pnpm dev:server .` を実行する
  2. 起動ログにサーバーの URL が表示されるのを待つ
  3. ブラウザでその URL を開く
- **期待結果:** `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".css"` が出ずにサーバーが起動し、プレビュー画面が表示される。
- **確認ポイント:** デフォルトの content.css スタイルがプレビュー本文に適用されていること（スタイル未適用の素の HTML になっていないこと）。

### 2. `start` スクリプトのパスが実ビルド出力と一致する

- **目的:** `pnpm start` が実在するエントリ（`dist/index.mjs`）を指していることを確認する。
- **手順:**
  1. `pnpm build` を実行する
  2. `dist/index.mjs` が生成されていることを確認する
  3. `package.json` の `start` が `node dist/index.mjs` を指していることを確認する
- **期待結果:** `start` の指すパスが生成物 `dist/index.mjs` と一致し、`dist/index.js`（非生成）を参照していない。

## エッジケース・異常系

### 1. クエリなしの `.css` インポートが従来通り動く

- **目的:** クエリ除去の変更がクエリなしの `.css` 読み込みに副作用を与えないことを確認する。
- **手順:**
  1. `pnpm dev:server .` 起動時に loader 経由で読まれる CSS が正しく文字列として取り込まれていること（プレビューのスタイル適用）で間接的に確認する
- **期待結果:** スタイルが正しく適用され、loader のフォールスルー（`nextLoad`）に流れない。

## 既存機能への影響確認

- 本番ビルド経路（`pnpm build` → `node dist/index.mjs <dir>`）は tsdown が処理するため今回の変更の影響を受けない。念のため `node dist/index.mjs .` でプレビューが従来通り表示されることを確認する。
- 自動テスト・型・lint への影響を確認する。

## 確認チェックリスト

- [ ] `pnpm dev:server .` がクラッシュせず起動する
- [ ] プレビューにデフォルト content.css スタイルが適用される
- [ ] `pnpm build` 後 `dist/index.mjs` が生成され、`start` がそれを指す
- [ ] `node dist/index.mjs .` で本番ビルド経路のプレビューが従来通り動く
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm lint` が通る
