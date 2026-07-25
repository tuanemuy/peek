# サーバー情報 — Issue #102 ブラウザ検証

**実行日:** 2026-07-25

## 通常の manual-test との違い

この Issue は **CLI プロセスのシャットダウン挙動**の修正であり、検証対象は「peek プロセスが SIGINT を受けて有限時間で終了するか」である。したがって:

- **オーケストレーターが 1 つのサーバーを起動して全テストケースで共有する、という通常のモデルは使えない。** 各テストケースが自分で peek を起動し、SIGINT を送って終了を観測し、後始末する。
- ブラウザ（agent-browser）は「実際に SSE 接続を保持する負荷源」として使う。ブラウザ操作そのものが検証対象なのは確認項目 4（再接続挙動）だけ。

## 起動コマンド

- **ビルド**: `pnpm build`（`package.json` の `scripts.build`）— 実行済み。`dist/index.mjs` 131.16 kB（gzip 33.44 kB）を生成
- **起動**: `node dist/index.mjs <対象パス> --host 0.0.0.0 --port <port> --no-open`
  - `dist/index.mjs` は `package.json` の `bin.peek` の実体そのもので、Issue の再現条件 `peek . --host 0.0.0.0 --port 3009` と同一の実行形態
  - `node` を直接呼ぶため peek は単一プロセスで、SIGINT / exit code をそのまま観測できる
- **不採用**: `pnpm dev`（`dev:css` を並行起動して `trap` で kill する複合コマンドのため、peek 単体の exit code を観測できない）、`pnpm dev:server` / `pnpm start`（pnpm ラッパーが挟まる）
- **検出ソース**: `.issue/102/testing.md` の「確認環境」セクション

## ポート割り当て

テストケースごとにポートを分けて衝突を避ける。3009〜3018 が空いていることを確認済み。

| TC | ポート |
|---|---|
| TC-001 | 3009（Issue の再現条件と同じポート） |
| TC-002 | 3010 |
| TC-003 | 3011 |
| TC-004 | 3012 |
| TC-006 | 3013 |
| TC-007 | 3014 |
| TC-008 | 3015 |
| TC-009 | 3016 |
| TC-010 | 3017 / 3018 |

## Node バージョン

- 既定: **v22.22.1**（`flake.nix` の devShell が `nodejs_22` を固定）
- 確認項目 6 用: **v24.18.0**（`nix shell nixpkgs#nodejs_24 -c node`）— 報告者環境は v24.15.0 でパッチバージョンは異なる
