# ADR — Issue #89: ファイルツリーの折りたたみ状態を永続化する

## ADR-001: プロジェクト識別子は targetPath の SHA-256 先頭 16 hex 文字

### Status
Proposed

### Context
origin(localhost:3000) 単位の localStorage がプロジェクト間で衝突する。クライアントで一意な識別子が必要だが、絶対パスはサーバー(`ServerConfig.targetPath`)のみが保持する。選択肢:
1. 生の絶対パスをそのままクライアントへ渡しキーに使う
2. パスのハッシュ（短縮）を渡す

### Decision
SHA-256 ハッシュの先頭 16 hex 文字を使う。生パスはユーザーのディレクトリ構造を `window.__INITIAL_STATE__`（HTML ソース）に露出させるため避ける。`node:crypto` はサーバー(Node ≥ 22)で利用可能。16 文字(64bit)で実用上の衝突は無視できる。ユーティリティは Node 依存のため `src/lib/project-id.ts` に置く（`src/core/` はフレームワーク/ランタイム非依存層のため不適）。

### Consequences
- 良い点: パス非露出、短いキー、決定的、サーバーのみで完結。
- トレードオフ: 識別子から元パスは復元不可（デバッグ時は不便だが要件上問題なし）。
- 脅威モデル注記（レビュー #001 W-002）: salt が無く入力（絶対パス）が予測しやすいため、識別子を得た攻撃者は候補パスの列挙で逆引きしうる。ただし peek は `localhost` バインドのローカル開発ツールであり、`projectId`（HTML ソース内）を取得できる時点で既に同一 origin へのアクセス権がある。決定性（リロード/再訪で同一）要件と salt の両立にはディスク永続化が必要で、ローカルツールの脅威モデルに対して過剰。よって salt 無しを採用する。

---

## ADR-002: localStorage は単一キーに「閉じているパス集合 + 最終アクセス日時」を全プロジェクト分保持

### Status
Proposed

### Context
保存単位として「開いている集合」か「閉じている集合」か、また 1 プロジェクト 1 キーか単一キー集約かを決める必要がある。デフォルト挙動は現状の全展開を維持したい。

### Decision
単一キー `file-tree-state` に `{ [projectId]: { collapsed: string[], lastAccess: number } }` を保持する。**閉じているパス集合**を持つ。

理由:
- デフォルト全展開と整合（記録が無いノード = 展開）。新規追加ディレクトリも自動展開され直感的。
- 省データ（明示的に閉じたものだけ記録）。
- 単一キー集約により、TTL パージを 1 回の read→purge→write で全プロジェクト横断で実行でき、キー走査が不要。
- `lastAccess` を各プロジェクトエントリに持たせ、TTL(既定 30 日)超過を初期化時にパージ。

### Consequences
- 良い点: パージが単純、デフォルト挙動と整合、省データ。
- トレードオフ: 1 キーに集約するため超多数プロジェクト時に 1 値が肥大化しうるが、TTL パージで抑制。collapsed のパス集合は SSE のツリー削除を即時反映しないが `isOpen` 判定にしか使われず無害。

---

## ADR-003: 開閉状態を共有フック useFileTreeState に持ち上げ、SSR 整合は isOpen 未指定フォールバックで担保

### Status
Proposed

### Context
現状 `DirectoryItem` がローカル `useState(true)` で開閉を持つ。永続化と SSE ツリー更新越しの状態保持には単一の真実源が要る。一方 `file-tree-items.tsx` は SSR とクライアント双方から使われ、ハイドレーション不一致を避ける必要がある。

### Decision
開閉状態を `useFileTreeState(projectId)` フックの collapsed 集合へ集約し、`isOpen`/`onToggle` を props ドリリングで伝播する。`Sidebar`/`FileTree`/`FileTreeItems`/`DirectoryItem` の `isOpen`/`onToggle` はすべて**オプショナル props** として定義する（SSR 経路の `renderDirectoryView` 内 `<Sidebar>` はこれらを渡さないため。必須にすると型エラーになる）。`DirectoryItem` は `isOpen` 未指定時 `true`(全展開)にフォールバック、`onToggle` は `?.` で no-op。クライアント側フックの初期 state は空集合(=全展開)とし、復元は `useLayoutEffect`(マウント後)で実施。これにより SSR/初回 render/復元前の DOM が全て全展開で一致し、不一致警告とちらつきを回避（`use-sidebar` と同パターン）。

### Consequences
- 良い点: 単一の真実源、SSE ツリー差し替えに強い(パスベース)、既存パターンと一貫。
- トレードオフ: props ドリリングが `Sidebar`→`FileTree`→`FileTreeItems`→`DirectoryItem` と続くが、階層が浅く Context 導入より単純。
