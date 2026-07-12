# TC-EDGE-2: TTL パージ

**結果**: PASS
**セッション**: verify-main
**現プロジェクト projectId**: `331492d18f68dc3f`

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | alpha 折りたたみ済・正常な localStorage の状態を確認 | 現プロジェクトの正常エントリが存在 | `{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763485363}}`（TC-EDGE-1 の自己修復で生成済） | PASS |
| 2 | 偽 projectId `old-fake-project`（lastAccess=31日前=1778085094594, collapsed:[]）を追加。現エントリは残す | 両エントリが書き込まれる | `{"331492d18f68dc3f":{...,"lastAccess":1780763485363},"old-fake-project":{"collapsed":[],"lastAccess":1778085094594}}` | PASS |
| 3 | リロード | - | reload 完了 | PASS |
| 4 | file-tree-state 再読込。old-fake-project が消え、現プロジェクトは残り lastAccess 更新を確認 | 30日超エントリがパージ、現プロジェクト維持＋lastAccess 更新 | `{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763500099}}`。old-fake-project は消失。lastAccess が 1780763485363 → 1780763500099 に更新（Date.now()=1780763502878 の約3秒前） | PASS |

## localStorage 観測値

- 注入前: `{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763485363}}`
- 注入後: `{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763485363},"old-fake-project":{"collapsed":[],"lastAccess":1778085094594}}`
  - 偽エントリ lastAccess = 1778085094594（= Date.now() - 31日）
- リロード後: `{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763500099}}`
  - 参考: リロード直後の Date.now() = 1780763502878

## スクリーンショット

- Step 4 (パージ後): `screenshots/tc-edge-2/step-04-after-purge.png`

## 所見

30日（TTL）を超過した偽プロジェクトエントリ `old-fake-project` がリロード時にパージされ、現プロジェクトのエントリは collapsed を保ったまま維持され、lastAccess も最新時刻に更新された。期待通り。
