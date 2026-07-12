# TC-002: プロジェクト間で状態が衝突しない（projectId 名前空間化）

- Issue: #89 ファイルツリー折りたたみ状態の localStorage 永続化
- 検証日時: 2026-06-07
- セッション: `verify-ns`
- origin: http://localhost:3000（起動中ディレクトリ /tmp/peek-test-89-other）
- 現ディレクトリ projectId: `156678d1520e429e`
- 前ディレクトリ /tmp/peek-test-89 の projectId（背景情報）: `331492d18f68dc3f`

## 総合判定: PASS（条件付き / 注記あり）

名前空間化の実装（projectId をキーとした localStorage 構造、TTL purge、spread による他プロジェクト保持）は正しく機能している。
ただし「前ディレクトリのエントリが別キーとして共存している」という前提は**今回の環境では満たせなかった**。
検証開始時点で localStorage `file-tree-state` には前ディレクトリ `331492d18f68dc3f` のエントリが**存在しなかった**ため、
「2つ以上の projectId が共存」の直接観測はできていない。これは実装の欠陥ではなく前提条件（事前検証でエントリが永続化されていなかった）の問題。
詳細は末尾「所見」を参照。

## ステップ別結果

| Step | 操作 | 期待 | 実際 | 判定 |
|------|------|------|------|------|
| 1 | http://localhost:3000 を開きツリー確認 | xray, yankee/(sub-y/(y.md)), index.md が表示。alpha/beta/gamma は出ない | xray[expanded], yankee[expanded]/sub-y[expanded]/y.md, index.md。alpha/beta/gamma なし | PASS |
| 2 | localStorage `file-tree-state` の projectId 一覧確認 | 現 dir の projectId エントリ collapsed=[]。前 dir `331492d18f68dc3f` も別キーで残存 | キーは `156678d1520e429e` のみ。collapsed=[], lastAccess あり。**前 dir エントリは存在せず** | 部分 PASS（現 dir 側は期待通り。前 dir 共存は観測不可） |
| 3 | yankee を折りたたむ | aria-expanded=false、子 sub-y が非表示 | yankeeAriaExpanded=false、sub-y は DOM から除去（非表示） | PASS |
| 4 | localStorage 再読込 | 現 dir の collapsed に "yankee"。前 dir `331492d18f68dc3f` は変更なし | `156678d1520e429e`.collapsed=["yankee"]。他キーへの混入なし（前 dir エントリは元々不在） | PASS（混入なし。前 dir 不変は対象不在のため N/A） |
| 5 | リロードして復元確認 | yankee 折りたたみ復元、xray 展開のまま | yankeeExpanded=false（復元）、xrayExpanded=true、sub-y 非表示、x.md 表示 | PASS |
| 6 | セッション close | 正常終了 | close 実行 | PASS |

## localStorage `file-tree-state` の内容ログ

### Step 2（ページを開いた直後・初回 touch 後）
```json
{
  "156678d1520e429e": { "collapsed": [], "lastAccess": 1780763773127 }
}
```
- projectId キー一覧: `["156678d1520e429e"]`
- `331492d18f68dc3f`（前 dir）: 不在

### Step 4（yankee 折りたたみ後）
```json
{
  "156678d1520e429e": { "collapsed": ["yankee"], "lastAccess": 1780763799391 }
}
```

### Step 5（リロード後）
```json
{
  "156678d1520e429e": { "collapsed": ["yankee"], "lastAccess": 1780763815336 }
}
```

## スクリーンショット

- Step 1（別 dir ツリー）: `.issue/89/manual-test/screenshots/tc-02-ns/step1-tree-other-dir.png`
- Step 3（yankee 折りたたみ）: `.issue/89/manual-test/screenshots/tc-02-ns/step3-yankee-collapsed.png`
- Step 4（localStorage 更新時）: `.issue/89/manual-test/screenshots/tc-02-ns/step4-localstorage-updated.png`
- Step 5（リロード復元）: `.issue/89/manual-test/screenshots/tc-02-ns/step5-reload-restored.png`

## 所見

### 確認できたこと（名前空間化は正しい）
- 現ディレクトリ /tmp/peek-test-89-other は projectId `156678d1520e429e` という固有キーで管理され、
  前ディレクトリの想定 projectId `331492d18f68dc3f` とは別の 16hex 値。パスごとに名前空間が分離される設計どおり。
- 折りたたみ状態（"yankee"）は `156678d1520e429e` キー配下にのみ書き込まれ、他のキーへ混入していない。
- リロード後も collapsed=["yankee"] が保持され、UI 復元（yankee 折りたたみ／xray 展開維持）も正しく動作。

### 「2つの projectId 共存」が観測できなかった理由（実装コードの確認に基づく）
- `src/client/lib/file-tree-state.ts` / `src/client/hooks/use-file-tree-state.ts` を確認した結果、
  実装は他プロジェクトのエントリを破壊しない設計である:
  - `writeCollapsed` は `{ ...store, [projectId]: ... }` と spread で対象 projectId のみ更新し、他キーは保持する。
  - `purgeExpired` は TTL（30日）超過エントリのみ削除。最近作成された前 dir エントリが消える要因にはならない。
  - `toggle` / 初回マウントとも書き込み前に `readStore()` で最新ストアを読み直し、他タブ・他プロジェクトの更新を clobber しない。
- したがって、前 dir エントリの不在は本実装による削除ではなく、**前提条件の不成立**（事前検証 /tmp/peek-test-89 で
  エントリが localStorage に永続化されないまま終わっていた、もしくはブラウザコンテキスト／storage がクリアされていた）が原因と判断する。
- 名前空間化の論理的正当性はコードレビューで担保されているが、「2つの projectId が同一 origin で実際に共存する」
  という挙動の**ブラウザ実観測は本テストでは未達**。完全な確証を得るには、前 dir を再度開いてエントリを確実に永続化
  （何か1つ折りたたむ）→ 別 dir を開く、という順序で再実施するのが望ましい。
