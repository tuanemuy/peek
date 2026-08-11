# シードデータ — Issue #102 ブラウザ検証

**実行日:** 2026-07-25

## 必要なデータ

peek は DB を持たないプレビュー CLI なので、マイグレーション・シードスクリプト・テストアカウント・環境変数はいずれも不要。必要なのは **プレビュー対象のファイル群** だけ。

## 用意したもの

リポジトリの `testdata/` をスクラッチパッドにコピーしてフィクスチャとした。

```
/private/tmp/claude-501/-Users-hikaru-github-com-tuanemuy-peek/e8a431d2-7f56-4d79-985e-b82d6ed91293/scratchpad/fixture/
```

内容（`testdata/` と同一）:

- Markdown 11 ファイル（`01-headings.md` 〜 `11-footnotes.md`）+ `README.md`
- `html/` — HTML ファイルモード用（`01-basic-structure.html` 他）
- `edge-cases/` / `japanese/` / `nested/` — サブディレクトリ

## リポジトリ内の `testdata/` を直接使わない理由

確認項目「既存機能への影響 > ライブリロード」でファイルの**編集・追加・削除**を行うため、リポジトリの作業ツリーを汚さないようコピーを使う。テスト終了後にフィクスチャごと破棄する。

HTML ファイルモードのみ、testing.md が `testdata/html/01-basic-structure.html` を名指ししているが、内容が同一のフィクスチャ側のコピーを使う（読み取りのみで副作用がないため、どちらでも結果は変わらない）。

## 環境変数

なし。`--host` / `--port` / `--no-open` はすべてコマンドライン引数で渡す。

## 後始末

フィクスチャディレクトリはスクラッチパッド配下にあり、リポジトリの `git status` に影響しない。
