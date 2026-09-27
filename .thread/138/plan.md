# Issue #138 契約: ファイルツリーのパスをツリーを作る時点で / 区切りにそろえる

## 目的

サーバーがファイルシステムや URL から受け取った相対パス（Windows では `\` 区切りになりうる）を、core とクライアントへ渡す前に `/` 区切りにそろえる。以後、ツリーのノード・変更通知・`/view` が描く `currentPath` はどれも `/` 区切りの同じ文字列として比べられる。

## パスの形

- `FileTreeNode.path` と SSE の `file-changed` の `path` は、ディレクトリモードの基準ディレクトリからの `/` 区切りの相対パス
- `/` 区切りであることは型 `SlashPath`（`src/core/slash-path.ts` のブランド型）で表す。サーバーで `SlashPath` を作るのは `toSlashPath` だけ。次の値を `SlashPath` にし、OS の相対パスや生の文字列をそのまま入れると型エラーになる
  - `FileTreeNode.path`
  - 表示中のファイルのパス: `DirectoryInitialState.currentPath`、`DirectoryApp` の `currentPath`、`useSseUpdates` の `getCurrentPath` が返すパス、`initialOpenState`・`revealFile`・`findAncestorPaths` が受け取るパス
  - ディレクトリのパス: トグルに渡すパス（`toggleDirectory`）、開閉を問うパス（`isDirectoryOpen`、`isOpen`）
  - クライアントが受け取る変更通知の `path`
- クライアントは OS を知らないので、外から来るパスを `SlashPath` として読む境界を 1 か所ずつ持つ。どれも検証はせず、サーバーが `/` 区切りで渡すという契約に基づいて型を付ける
  - `/view` の URL の `?path=` と履歴の `state.path`: `src/client/lib/path-utils.ts` の 1 関数
  - `/api/tree` の JSON: `fetchTree`（従来どおり）
  - SSE の `file-changed`: `parseFileChangedData`
- OS の区切り（`path.sep`）を `/` に置き換える規則は `src/core/path.ts` の `toSlashPath` 1 関数だけが持つ。POSIX では `\` はファイル名の文字なので置き換えない
- Issue の完了条件「そろえる処理がツリーを作る境界の 1 か所だけにある」は、規則（置き換えの実装）が 1 か所にあることと読む。Issue の本文どおりツリーだけでそろえると、Windows の `fs.watch` が返す `\` 区切りの通知をそろえる置き換えがどこかに残り、同じ規則が 2 か所になるため。規則を適用するのは、OS 形式のパスがサーバーに入って core・クライアントの比較に届く次の 3 か所で、どれも `toSlashPath` を呼ぶだけで自前の置き換えを持たない
  - `buildFileTree`（`src/lib/file-tree.ts`）: `path.relative` から作るノードの `path`
  - ディレクトリの watcher（`src/server/index.ts`）: `fs.watch` が返すファイル名
  - `/view`（`src/server/routes/directory.tsx`）: `?path=`。以前のツリーのリンク（Windows で `?path=a%5Cb.md`）のブックマークで、強調・祖先の展開・ライブリロードが効くようにする
- `.gitignore` の判定は従来どおり OS の相対パスで行う（`ignore` への入力は変えない）
- ファイルシステムの操作は従来どおり `resolve(base, path)` で OS のパスに戻す。Windows の `resolve` は `/` を区切りとして扱う。本文中の `/view?path=a/b.md` リンクは変更前から Windows でこの経路を通っている

## `/view` の正規化

- `toSlashPath(path) !== path` なら、`/view?path=<toSlashPath(path)>` へ 302 でリダイレクトする。`path` 以外のクエリは `/view` が読まないので残さない
- リダイレクトは 403（基準の外）・404（非対応の拡張子・ファイルが無い）の判定より先に行う。判定はリダイレクト先で同じ規則で行われる
- そろえても変わらないパス（POSIX では常に。`\` を含むファイル名も）はリダイレクトせず、従来どおり描く

## 比較に届かない入口

`/api/content`・`/__peek/raw/`・`/<相対パス>` は `?path=` やパスをファイルシステムの操作にだけ使い、ツリー・通知との比較には渡さない。Windows で `\` 区切りを受けても `resolve` で同じファイルに解決できるので、そろえない。

## 受け入れ基準

| # | 基準 | 観測方法 |
| --- | --- | --- |
| AC1 | Windows 形式（`sep` が `\`、`relative` が `\` 区切り）の入力で `buildFileTree` を作ると、ネストしたディレクトリ・ファイルを含む全ノードの `path` が `/` 区切りになる | 自動テスト（`node:path` をモック） |
| AC2 | POSIX で `\` を含むファイル名のノードの `path` は `\` を保つ。上に挙げた `SlashPath` の値に生の文字列を入れると、サーバー側でもクライアント側でも型エラーになる | 自動テスト、`expectTypeOf` による型のテスト、`pnpm typecheck`（`tsconfig.json` と `tsconfig.client.json` の両方） |
| AC3 | `toSlashPath` は `sep` が `\` なら `\` を `/` に置き換え、`sep` が `/` なら入力をそのまま返す | 自動テスト（`sep` をモック） |
| AC4 | watcher の変更通知の `path` は、Windows では `\` を `/` にしたもの、POSIX では `\` を含むファイル名をそのまま保ったもの | 自動テスト（watcher をモックし、`sep` を切り替えて通知される `path` を見る） |
| AC5 | `findAncestorPaths` は区切り文字を読み取らず、ディレクトリ（`type === "directory"`）のうち「そのパス + `/`」で始まるものを祖先として返す。名前が前方一致するだけのディレクトリ（`docs` と `docs-old`）は祖先にしない。`\` はそのディレクトリの区切りとして扱わない。`.gitignore` でツリーから外れたファイルでも、ツリーにある祖先を返す。`\` 区切りのツリーを前提にした既存テストは削除する | 自動テスト |
| AC6 | Windows 形式の入力で作ったツリーを、本文中のリンクと同じ `/` 区切りの `currentPath`（`a/b/c.md`）で描くと、`c.md` の行が表示中として強調され、`a`・`a/b` が開いている。SSR の初期状態と、`root.md` から移動したとき（`revealFile`）の両方 | 自動テスト（AC1 と同じモックで作ったツリーをサイドバーに描く）、Windows 実機の browser |
| AC7 | `\` を `/` に置き換える処理は `toSlashPath` だけにある。クライアントの `normalizePath`（呼び出し元 `src/client/lib/sse.ts`・`src/client/hooks/use-sse-updates.ts`、テスト `src/client/lib/path-utils.test.ts`）、watcher の `replace(/\\/g, "/")`、`findAncestorPaths` の区切り読み取りは無くなる。テストも置き換えを自前で書かず、`sep` を切り替えて `toSlashPath` を通す | コマンド出力（`src/` 全体の grep。テストを含む） |
| AC8 | Windows で `/view` は `toSlashPath` で変わるパスを 302 でそろえた URL へリダイレクトし、403 / 404 の判定より先に行う。POSIX では `\` を含むファイル名の `?path=` もリダイレクトせずに描く | 自動テスト（`sep` を切り替える。POSIX 側は `\` を含むファイル名を描くことまで）、Windows 実機の browser（302 の応答と、たどり着いた画面）、darwin の browser（`\` を含む `?path=` をリダイレクトしないこと。フィクスチャにそのファイルは無いので 404） |
| AC9 | Windows の `resolve` が `/` 区切りの相対パスを基準ディレクトリの下のパスに解決する（`/view`・`/api/content`・`/__peek/raw/` が `/` 区切りで動く前提） | コマンド出力（`path.win32.resolve` / `isWithinBase` 相当の確認） |
| AC10 | 本文中の `/view?path=a/b/c.md` のリンクから移動すると、ツリーで `a`・`a/b` が開き、`c.md` の行が表示中として強調される | browser（Windows 実機・darwin） |
| AC11 | 表示中のファイルを書き換えると、本文がページの再読み込みなしに更新される。別のファイルを書き換えると、変更通知は届いてツリーを再取得し、本文は再取得しない | browser（Windows 実機・darwin）＋ 自動テスト |
| AC12 | サイドバーのリンク・`/`（最初のファイル）・`/api/content`・`/__peek/raw/`・`/<相対パス>` がこれまでどおり動く | 既存の自動テスト ＋ browser（Windows 実機・darwin） |

darwin では `toSlashPath` が恒等なので、darwin の観測は変更の前後で結果が変わらないことの確認。Windows での一致は GitHub Actions の `windows-latest` 上で peek を動かし、ブラウザで観測する。同じ手順を変更前（`origin/main`）にも流し、結果の違いを記録する。観測は各ビューポートで行う。観測するのは PR の最終コミットで、観測したコミットを PR に書く。

既存の振る舞いについては、同じ `windows-latest` で変更前と変更後の `pnpm test` を実行し、変更後に新しく失敗するテストが無いことを確かめる（変更前から Windows で失敗するテストは、この PR の範囲外として一覧を記録する）。観測スクリプトとワークフローは `.thread/138/windows-observation/` に残す。

## スコープ

- 含む: `pnpm typecheck` に `tsconfig.client.json` を加え、そのために既存の `use-sidebar.ts` の型エラーを直す（クライアント側の `SlashPath` をゲートで守るため。#140）、`toSlashPath` の追加、`buildFileTree` のノードパス、watcher の通知パス、`findAncestorPaths` の単純化、`/view` の正規化リダイレクト、クライアントの `normalizePath` の削除、関連テストとドキュメンテーションコメントの更新
- 含まない
  - クライアント内の SPA 移動で `\` 区切りの `?path=` を受ける場合（本文中のリンク、更新前に積まれた履歴エントリの `state.path` を戻る・進むで辿る場合）。サーバーの `/view` を通らないためそろえない。クライアントは OS を知らず、`?path=` は `/` 区切りとする
  - `getExtension`（`src/core/content-type.ts`）の `\` の扱い。OS の絶対パス（ファイルモードの対象）にも使うため変えない
  - `localStorage` に保存済みの Windows の `\` 区切りの `expanded`。保存形式 `expanded` はリリース前（#135 が 1.10.0 の後にマージ）なので移行しない

## 対象ビューポート

`CLAUDE.md` / `spec/design/` に定めが無いため、デスクトップ 1280×800 とモバイル 390×844 とする。見た目は変えない。
