# TC-EDGE-1: localStorage 破損でもクラッシュしない

**結果**: PASS
**セッション**: verify-main
**projectId**: `331492d18f68dc3f`

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | eval で `localStorage.setItem('file-tree-state','{invalid')` | 破損値が書き込まれる | 値が `{invalid` に設定された | PASS |
| 2 | リロード | - | reload 完了、errors clear 済 | PASS |
| 3 | 画面が壊れず全展開デフォルトで表示されることを確認 | クラッシュせず全展開 | alpha:true, sub-a1:true, sub-a2:true, beta:true, gamma:true, deep:true, deeper:true（全展開）。errors: 空（クラッシュなし） | PASS |
| 4 | alpha をクリックして折りたためることを確認 | 開閉操作ができる | alpha クリックで alpha:false に変化、localStorage が valid JSON `{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763485363}}` に再生成された | PASS |

## localStorage 観測値

- 破損注入後: `{invalid`
- リロード後（破損のまま、画面は全展開デフォルト）
- alpha クリック後（自己修復）: `{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763485363}}`

## スクリーンショット

- Step 3 (破損後リカバリ・全展開): `screenshots/tc-edge-1/step-03a-corrupt-recovered-allexpanded.png`
- Step 4 (トグル動作・alpha 折りたたみ): `screenshots/tc-edge-1/step-03b-toggle-works-alpha-collapsed.png`

## 所見

破損 JSON が localStorage にあってもクラッシュせず、全展開デフォルトで表示された。さらに開閉操作を行うと localStorage が valid な状態に自己修復された。期待通り。
