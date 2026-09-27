# ADR — Issue #138: ファイルツリーのパスをツリーを作る時点で / 区切りにそろえる

## ADR-001: 区切りの規則を `toSlashPath` 1 関数に置き、OS 形式のパスが入る境界で呼ぶ

### Context

Issue は「`/` と `\` をそろえる処理がツリーを作る境界の 1 か所だけにある」ことを求める。一方で OS 形式の相対パスがサーバーに入る箇所はツリーの構築だけではない。

- `buildFileTree`: `path.relative` の戻り値
- ディレクトリの watcher: `fs.watch` が返すファイル名（Windows では `\` 区切り）
- `/view?path=`: 変更前のツリーのリンクは Windows で `?path=a%5Cb.md` だったため、そのブックマークが `\` 区切りで来る

ツリーだけでそろえると、watcher の通知は Windows で `\` 区切りのまま届き、クライアントに置き換えを残すことになる。`/view` でそろえないと、以前のブックマークで強調・祖先の展開・ライブリロードが効かなくなる。

案:

1. ツリーだけでそろえ、watcher とクライアントの置き換えを残す
2. 規則を 1 関数にし、3 つの境界で呼ぶ
3. 通知と URL の突き合わせをすべてクライアントで正規化する

### Decision

案 2 を採る。`src/core/path.ts` の `toSlashPath(osPath)` は `osPath.split(sep).join("/")`。`sep` で割るので、POSIX では `\` をファイル名の文字として残す（変更前の watcher とクライアントの `replace(/\\/g, "/")` は POSIX でも `\` を置き換えていた）。

`/view` はそろえたパスが入力と違うとき、403 / 404 の判定より先に 302 でそろえた URL へリダイレクトする。判定はリダイレクト先で同じ規則で行われる。301 はブラウザがキャッシュするので使わない。

### Consequences

- core とクライアントは `/` 区切りだけを受け取り、祖先の判定・強調・通知の突き合わせは文字列の比較で済む
- クライアント内の SPA 移動（本文中のリンク、戻る・進む）はサーバーの `/view` を通らないので、`\` 区切りの `?path=` はそろわない。クライアントは OS を知らないため、`?path=` は `/` 区切りとする
- `getExtension` は OS の絶対パスにも使うので `\` の扱いを残す

## ADR-002: `/` 区切りのパスをブランド型 `SlashPath` で表す

### Context

`FileTreeNode.path` が `/` 区切りであることをドキュメンテーションコメントだけで述べると、`buildFileTree` が OS の相対パスをそのままノードに入れても型が通る。

### Decision

`src/core/slash-path.ts` に `SlashPath`（`string` のブランド型）を置き、`FileTreeNode.path` の型にする。サーバーで `SlashPath` を作るのは `toSlashPath` だけ。型はクライアントの tsconfig からも読むので、`node:path` を読む `src/core/path.ts` とは別のファイルに置く。

テストは `node:path` の `sep` を切り替えて `toSlashPath` を通し、置き換えを自前で書かない。

### Consequences

- OS の相対パスをノードに入れると型エラーになる
- テストのツリーの固定値は `as SlashPath` で作る。クライアントが `/api/tree` の JSON を `FileTreeNode[]` として読むのは従来どおり境界での型付け

## ADR-003: 表示中のファイルのパスとクライアントの入力も `SlashPath` にする

### Context

ADR-002 では `FileTreeNode.path` だけを `SlashPath` にした。表示中のファイルのパス（`DirectoryInitialState.currentPath`、`findAncestorPaths`・`initialOpenState`・`revealFile` の引数）は `string` のままで、`/view` がそろえずに `\` 区切りのパスを渡しても型は通る。

### Decision

表示中のファイルのパス、ツリーの状態を変える関数が受け取るパス、クライアントが受け取る変更通知の `path` を `SlashPath` にする。クライアントは OS を知らず検証もできないので、外から来るパスを読む境界で型を付ける。境界は `/view` の URL（`readViewPath`）、`/api/tree`（`fetchTree`）、SSE（`parseFileChangedData`）の 3 つ。

テストで `node:path` の `sep` を切り替える仕組みは `src/test-utils/os-separator.ts` にまとめる。既定ではホストの `sep` を返すので、同じファイルの別のテスト（`isWithinBase` など）は Windows のホストでもホストの区切りで動く。

### Consequences

- 表示中のファイルのパスを `toSlashPath` を通さずにサーバーから渡すと、型エラーになる
- `pnpm typecheck` は `tsconfig.json` だけを見ていて、`src/client/` は対象外（`tsconfig.client.json`）。クライアントの型は `npx tsgo -p tsconfig.client.json` で確かめた。この設定には変更前から `use-sidebar.ts` のエラーがある
