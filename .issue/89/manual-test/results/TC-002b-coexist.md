# TC-002b: 同一 origin での複数 projectId 名前空間の共存・相互不干渉

- Issue: #89（名前空間化）
- 観点: 同一 origin の単一 localStorage キー `file-tree-state` 内で、複数 projectId のエントリが共存し、サーバー再起動（別ディレクトリ）を挟んでも一方の折りたたみ操作が他方を変更しないこと
- 実行日時: 2026-06-07
- セッション: verify-coexist
- 環境:
  - peek-test-89: `/tmp/peek-test-89`（alpha/(sub-a1,sub-a2), beta, gamma/(deep/(deeper)), index.md） projectId `331492d18f68dc3f`
  - peek-test-89-other: `/tmp/peek-test-89-other`（xray, yankee/(sub-y), index.md） projectId `156678d1520e429e`
  - サーバー: http://localhost:3000

## 総合結果: PASS

2つの projectId エントリが同一 origin の単一キー `file-tree-state` 内に共存し、サーバー再起動を挟んでも、一方の折りたたみ操作が他方を一切変更しないことを観測した。

## ステップ別結果

| # | 手順 | 期待 | 観測 | 判定 |
|---|------|------|------|------|
| 1 | localStorage クリーン → リロード | `file-tree-state`=null | removeItem 後 null。リロード後ツリー表示 | PASS |
| 2 | peek-test-89 で alpha 折りたたみ | alpha aria-expanded=false / 331492 collapsed=["alpha"] | alphaExpanded=false、331492 entry={collapsed:["alpha"],lastAccess:1780763971277} | PASS |
| 3 | サーバーを other dir に再起動 | HTTP 200 復帰 | 2秒で READY、final=200 (pid 59340) | PASS |
| 4 | リロード → ツリー確認 | xray/yankee 表示、alpha/beta/gamma 非表示 | toggles=[xray,yankee,sub-y]、hasAlpha/Beta/Gamma=false | PASS |
| 5 | **核心: 2 projectId 共存確認** | 331492(collapsed=["alpha"]) と 156678(collapsed=[]) が共存、331492 不変 | projectIds=[331492d18f68dc3f,156678d1520e429e] count=2。331492={collapsed:["alpha"],lastAccess:1780763971277}（不変）、156678={collapsed:[],lastAccess:1780763990205}（初回touch） | PASS |
| 6 | other で yankee 折りたたみ → 不干渉確認 | 156678 collapsed=["yankee"]、331492 collapsed=["alpha"] 不変 | yankeeExpanded=false。156678={collapsed:["yankee"],lastAccess:1780764009927}、331492={collapsed:["alpha"],lastAccess:1780763971277}（lastAccess含め完全不変） | PASS |
| 7 | セッション close（サーバーは継続） | close 成功、server 継続 | Browser closed、HTTP 200 継続 | PASS |

## 各時点の file-tree-state スナップショット

### 時点A（Step 2 後・alpha 折りたたみ直後 / dir=peek-test-89）

| projectId | collapsed | lastAccess |
|-----------|-----------|------------|
| 331492d18f68dc3f | ["alpha"] | 1780763971277 |

```json
{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763971277}}
```

### 時点B（Step 5・other dir リロード後 / 核心）

| projectId | collapsed | lastAccess |
|-----------|-----------|------------|
| 331492d18f68dc3f | ["alpha"] | 1780763971277 |
| 156678d1520e429e | [] | 1780763990205 |

```json
{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763971277},"156678d1520e429e":{"collapsed":[],"lastAccess":1780763990205}}
```

- 331492 の collapsed=["alpha"]・lastAccess は時点A から変更されず保持。
- 156678 は初回 touch で collapsed=[]。

### 時点C（Step 6・other で yankee 折りたたみ後）

| projectId | collapsed | lastAccess |
|-----------|-----------|------------|
| 331492d18f68dc3f | ["alpha"] | 1780763971277 |
| 156678d1520e429e | ["yankee"] | 1780764009927 |

```json
{"331492d18f68dc3f":{"collapsed":["alpha"],"lastAccess":1780763971277},"156678d1520e429e":{"collapsed":["yankee"],"lastAccess":1780764009927}}
```

- 156678 のみ collapsed=["yankee"] に更新、lastAccess も更新。
- 331492 は collapsed・lastAccess とも時点A から完全不変（相互不干渉が確定）。

## スクリーンショット

- `/Users/hikaru/github.com/tuanemuy/peek/.issue/89/manual-test/screenshots/tc-02b-coexist/01-alpha-collapsed.png` — peek-test-89 で alpha 折りたたみ
- `/Users/hikaru/github.com/tuanemuy/peek/.issue/89/manual-test/screenshots/tc-02b-coexist/02-other-tree.png` — other dir 再起動後ツリー（xray/yankee）
- `/Users/hikaru/github.com/tuanemuy/peek/.issue/89/manual-test/screenshots/tc-02b-coexist/03-coexist.png` — 2 projectId 共存状態
- `/Users/hikaru/github.com/tuanemuy/peek/.issue/89/manual-test/screenshots/tc-02b-coexist/04-yankee-collapsed.png` — other で yankee 折りたたみ後

## 結論

- 同一 origin の単一キー `file-tree-state` 内に、`331492d18f68dc3f`（peek-test-89）と `156678d1520e429e`（peek-test-89-other）の2つの projectId エントリが共存することを観測（count=2）。
- サーバーを別ディレクトリへ再起動しても、前ディレクトリのエントリ（collapsed=["alpha"]）は削除・変更されず保持された。
- other 側で yankee を折りたたんでも、前ディレクトリ 331492 の collapsed/lastAccess は完全に不変であり、相互不干渉が確認できた。
- 名前空間化の核心要件を満たす: **PASS**
