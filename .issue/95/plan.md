# 実装計画 — Issue #95: 開発/ビルドツールの不整合: dev:server が起動できない & start スクリプトのパス誤り

**Issue:** #95
**作成日:** 2026-06-07
**複雑度:** 小規模

---

## 目的

ローカル開発・実行のワークフローを壊している、本筋と無関係なビルドツール周りの不整合を2点修正する。

1. `pnpm dev:server`（および `pnpm dev`）が `content.css?inline` の読み込みでクラッシュする問題を解消し、ドキュメント上の開発ループを動くようにする。
2. `pnpm start` のパス誤り（`dist/index.js`）を実ビルド出力（`dist/index.mjs`）に合わせる。

## スコープ

### 含まれるもの

- `src/loaders/css.mjs` の loader マッチ条件を `?inline` などのクエリ付き URL に対応させる
- `package.json` の `start` スクリプトを `node dist/index.mjs` に修正する

### 含まれないもの

- ビルド構成（tsdown / postcss）そのものの見直し
- `?inline` 以外の任意クエリに対する汎用ローダー設計（本Issueの再現に必要な範囲のみ対応）
- Issue #89 関連の変更（本Issueは独立した修正）

## 実装ステップ

### 1. css loader をクエリ付き URL に対応させる

- **対象ファイル:** `src/loaders/css.mjs`
- **変更内容:** `load` フック内で URL のクエリ文字列（`?inline` 等）を除去したパスで `.css` 判定し、`fileURLToPath` にもクエリを除いた URL を渡す。
  - 例: `const cleanUrl = url.split("?")[0];` を作り、`cleanUrl.endsWith(".css")` で判定、`readFileSync(fileURLToPath(cleanUrl), "utf-8")` で読む。
- **理由:** `src/lib/styles.ts` の `import contentCssDefault from "../styles/content.css?inline";` は `file://.../content.css?inline` という URL になり、現状の `url.endsWith(".css")` にマッチしないため Node 標準ローダーへフォールスルーして `ERR_UNKNOWN_FILE_EXTENSION` でクラッシュする。クエリを除去して判定すれば本来の loader が処理できる。

### 2. start スクリプトのパスを修正する

- **対象ファイル:** `package.json`
- **変更内容:** `"start": "node dist/index.js"` → `"start": "node dist/index.mjs"`
- **理由:** tsdown（`format: "esm"` / `type: "module"`）のビルド出力と `bin` は `dist/index.mjs` であり、`dist/index.js` は生成されないため現状の `start` は動かない。

## 設計判断

クエリ除去は `url.split("?")[0]` というシンプルな方法を採る。`new URL(url).pathname` で判定する案もあるが、`fileURLToPath` に渡す URL もクエリを除く必要があるため、クエリ手前を一度切り出して両方に使うのが最も簡潔で意図が明確。トレードオフのある技術選択ではないため ADR は不要。

## リスクと注意点

- loader は `data:` URL に埋め込まれた文字列として `register` されるため、変更後の構文が文字列内でも正しいことを確認する（テンプレートリテラルのエスケープに注意）。
- クエリ除去によって既存の `.css`（クエリなし）インポートの挙動が変わらないこと（`"file://.../x.css".split("?")[0]` は元の文字列のまま）を確認する。
- 本番ビルド（`pnpm build` → `node dist/index.mjs`）は tsdown が処理するため、今回の変更の影響を受けない。

## テスト方針

- `pnpm dev:server <dir>` がクラッシュせず起動し、ブラウザでプレビューが表示されること（content.css のデフォルトスタイルが適用されること）。
- `pnpm build` 後に `pnpm start` ではなく、`start` スクリプトが指すパスが実在する出力（`dist/index.mjs`）になっていること。
- 既存テスト（`pnpm test`）・typecheck・lint が通ること。
