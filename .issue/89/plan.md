# 実装計画 — Issue #89: ファイルツリーの折りたたみ状態を永続化する

**Issue:** #89
**作成日:** 2026-06-07
**複雑度:** 中〜大規模

---

## 目的

ファイルツリーのディレクトリ開閉状態がページリロード/再訪で失われる問題を解決する。各ディレクトリの開閉状態を localStorage に永続化し、復元する。peek は様々なディレクトリで起動される CLI ツールでデフォルトポート 3000 固定のため、origin(localhost:3000) 単位の localStorage がプロジェクト間で衝突する。これを防ぐため、サーバー側で `targetPath`（絶対パス）からプロジェクト識別子（ハッシュ）を生成し `InitialState` 経由でクライアントへ渡し、localStorage キーを名前空間化する。さらに TTL（既定 30 日）超過エントリを初期化時にパージして肥大化を防ぐ。

## スコープ

### 含まれるもの

- サーバー側でのプロジェクト識別子（`targetPath` のハッシュ）生成と `InitialState`（`DirectoryInitialState`）への追加、`window.__INITIAL_STATE__` 経由でのクライアント伝達
- ファイルツリー各ディレクトリの開閉状態の localStorage 永続化（プロジェクト識別子で名前空間化）
- 永続状態に無いノードのデフォルト挙動の定義（= 展開）
- TTL によるパージ（クライアント初期化時。TTL 日数は定数化）
- SSR/ハイドレーション整合性の確保（マウント後に localStorage を読む）
- SSE による tree 更新後も開閉状態が壊れないこと
- 開閉状態を `DirectoryItem` のローカル state から共有 state（カスタムフック）へ持ち上げる

### 含まれないもの

- 既存の `sidebar-open` / `sidebar-width` / `theme` キーの名前空間化（Issue 本文でも「素地がある」と述べるに留まっており、本 Issue のスコープ外）
- ファイルモード（単一ファイルプレビュー）への適用（ファイルツリーが無いため対象外）
- HTML ファイル単体ビュー（`renderHtmlDocument` 経由、Preact ハイドレーション無し）への適用

## 実装ステップ

### 1. プロジェクト識別子生成ユーティリティ（サーバー側 / Node）

- **対象ファイル:** `src/lib/project-id.ts`（新規）, `src/lib/project-id.test.ts`（新規）
- **変更内容:**
  - `node:crypto` の `createHash("sha256")` で絶対パス文字列をハッシュし、`digest("hex")` の先頭 16 文字（64 bit 相当）を返す純粋関数 `createProjectId(absolutePath: string): string` を実装する。
  - 入力は `resolve()` 済みの絶対パスを前提とするが、関数内でも `path.resolve` で正規化してから渡し、末尾スラッシュ等の差異で識別子がぶれないようにする。
  - 単体テスト: 同一パスで安定（決定的）、異なるパスで別の値、`/foo` と `/foo/`（正規化後同一）で同一値になること。
- **理由:** 絶対パスはサーバーのみが保持する。`node:crypto` はサーバー（Node ≥ 22）でのみ利用可能なため、Node 依存ユーティリティを置く `src/lib/` に配置するのが規約に沿う。`src/core/`（フレームワーク非依存・ブラウザでも import されうる層）には置かない。

### 2. `DirectoryInitialState` に `projectId` を追加

- **対象ファイル:** `src/core/initial-state.ts`
- **変更内容:** `DirectoryInitialState` に `readonly projectId: string;` を追加する。`FileInitialState` には追加しない（ファイルモードはツリーが無く永続化対象外）。
- **理由:** クライアントへ識別子を伝達する経路は既存の `InitialState`（`window.__INITIAL_STATE__`）。型に追加することで型安全に伝達できる。

### 3. サーバー側で `projectId` を生成し `InitialState` に埋め込む

- **対象ファイル:** `src/server/routes/directory.tsx`
- **変更内容:**
  - `createDirectoryRoutes(dirPath, ...)` の `dirPath`（= 絶対 `targetPath`）から `createProjectId(dirPath)` で識別子を 1 度算出する（ルートハンドラ内で都度計算でもよいが、`createDirectoryRoutes` の冒頭で 1 度計算して両ルートで共有するのが簡潔）。
  - `renderDirectoryView` の引数に `projectId` を追加し、`initialState` の `mode: "directory"` オブジェクトに含める。
  - `/` と `/view` の両ハンドラから `projectId` を渡す。
- **理由:** `dirPath` は `src/index.ts` の `resolve(targetPath)` 由来の絶対パスであることを確認済み（`startServer` → `ctx.targetPath` → `createDirectoryRoutes` の `dirPath`）。識別子生成の自然な場所はこのルート層。

### 4. `document.tsx` — シリアライズはそのまま

- **対象ファイル:** `src/server/renderer/document.tsx`
- **変更内容:** 変更不要。`initialState` を `JSON.stringify` で `window.__INITIAL_STATE__` にシリアライズしており、`projectId`（文字列）は自動的に含まれる。型が `InitialState` を参照しているため追加フィールドも透過的に通る。
- **理由:** 影響範囲を明示するため記載。実装作業は無い。

### 5. localStorage 永続化の純粋ロジック（クライアント / DOM 非依存）

- **対象ファイル:** `src/client/lib/file-tree-state.ts`（新規）, `src/client/lib/file-tree-state.test.ts`（新規）
- **変更内容:** `Storage` を直接触らない純粋関数群を実装し、単体テスト可能にする（テストは Node 環境で DOM 無し。既存テストと同様）。
  - 定数 `FILE_TREE_STATE_KEY = "file-tree-state"`、`TTL_DAYS = 30`（`TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000`）。
  - データ構造（localStorage に 1 キーで全プロジェクト分を保持）:
    ```ts
    type ProjectEntry = {
      readonly collapsed: readonly string[]; // 閉じているディレクトリの相対パス集合
      readonly lastAccess: number;           // epoch ms
    };
    type FileTreeStateStore = Record<string /* projectId */, ProjectEntry>;
    ```
  - `parseStore(raw: string | null): FileTreeStateStore` — JSON パース。壊れていれば空オブジェクトを返す（防御的）。
  - `purgeExpired(store, now, ttlMs): FileTreeStateStore` — `now - lastAccess > ttlMs` のエントリを除去した新しい store を返す（純粋）。
  - `getCollapsedSet(store, projectId): Set<string>` — 該当プロジェクトの `collapsed` を `Set` 化（無ければ空集合）。
  - `writeCollapsed(store, projectId, collapsed: Set<string>, now): FileTreeStateStore` — 該当プロジェクトの `collapsed` と `lastAccess` を更新した新しい store を返す。`collapsed` が空集合になってもエントリは残す（`lastAccess` 更新のため。パージで TTL 管理）。
  - `serializeStore(store): string` — `JSON.stringify`。
- **理由:**
  - 「閉じているパス集合（collapsed）」を持つことで、デフォルト挙動「全展開」と整合し、かつ省データ（既存の全展開 UX を維持しつつ、明示的に閉じたものだけ記録）。新規ディレクトリ追加時も自動的に展開され、直感に沿う。
  - 純粋関数に切り出すことで、DOM が無い vitest 環境でロジックを単体テストできる（プロジェクトの「ステートレス・純粋関数志向」原則に合致）。

### 6. 開閉状態管理フック `useFileTreeState`

- **対象ファイル:** `src/client/hooks/use-file-tree-state.ts`（新規）
- **変更内容:**
  - シグネチャ: `useFileTreeState(projectId: string): { isOpen(path: string): boolean; toggle(path: string): void }`。
  - 内部状態は `useState<Set<string>>(() => new Set())`（= collapsed 集合）。**初期値は常に空集合**（= SSR と同じ全展開状態）。
  - `useLayoutEffect`（`use-sidebar` と同じく、マウント後・ペイント前に DOM 反映してハイドレーション不一致＆ちらつきを回避）で、初回マウント時のみ:
    1. `parseStore(localStorage.getItem(FILE_TREE_STATE_KEY))`
    2. `purgeExpired(store, Date.now(), TTL_MS)` でパージ
    3. パージ後 store の該当 `projectId` の `lastAccess` を `Date.now()` に更新（`writeCollapsed` で現 collapsed=該当プロジェクトの既存集合のまま touch）し、`serializeStore` で書き戻す（パージ結果も永続化）
    4. `getCollapsedSet(purgedStore, projectId)` を `setCollapsed` で state に反映
  - `toggle(path)`: collapsed 集合に path があれば削除、無ければ追加した新しい `Set` を `setCollapsed`。同時に `writeCollapsed(store, projectId, nextSet, Date.now())` → `serializeStore` で localStorage 永続化。書き込み時は最新の localStorage を読み直してから該当プロジェクトのみ更新（他タブ/他プロジェクト書き込みの取りこぼし防止）。
  - `isOpen(path)`: `!collapsed.has(path)`（デフォルト展開）。
  - localStorage アクセスは try/catch でガード（プライベートモード等で例外を投げうるため。`use-sidebar` は未ガードだが新規コードでは堅牢に）。初回マウントと `toggle` の両方で「read → 純粋関数で変換 → write」を行うため、try/catch 込みの薄い副作用ラッパ `readStore()` / `writeStore(store)` をフック内ローカル関数として定義し、I/O ロジックの重複と取りこぼしを防ぐ。
  - **パージのタイミング:** Issue 本文は「起動時（またはクライアント初期化時）」とするが、localStorage はブラウザにのみ存在しサーバーからは触れないため、パージは必ずクライアント初期化時（このフックの初回 `useLayoutEffect`）に行う。これが要件の唯一実現可能な解釈。
- **理由:** `DirectoryItem` のローカル `useState(true)` を共有 state に持ち上げる。集合をフックで一元管理し、全 `DirectoryItem` が同一の collapsed 集合を参照することで、SSE による tree 差し替え後もパス単位で開閉状態が保たれる（state はパス集合でツリー構造に依存しない）。`use-sidebar` の `useLayoutEffect` + `initialMount` パターンを踏襲し一貫性を保つ。

### 7. `DirectoryItem` / `FileTreeItems` を共有 state 駆動に変更

- **対象ファイル:** `src/components/navigation/file-tree-items.tsx`, `src/components/navigation/file-tree.tsx`, `src/components/navigation/sidebar.tsx`
- **変更内容:**
  - `DirectoryItem` の `const [open, setOpen] = useState(true)` を撤廃。代わりに props で `isOpen?: (path: string) => boolean` と `onToggle?: (path: string) => void` を**オプショナル**で受け取り、`const open = isOpen ? isOpen(node.path) : true;`、`onClick={() => onToggle?.(node.path)}` とする。
  - `FileTreeItems` / `FileTree` / `Sidebar` の各 props 型にも `isOpen?` / `onToggle?` を**オプショナル**で追加し伝播させる（props ドリリング。コンポーネント階層が浅いため Context は導入しない）。`FileTreeItems` は再帰呼び出しなので、再帰経路でも両 props を渡し続ける。
  - **SSR 整合:** サーバー側 `renderDirectoryView` 内の `<Sidebar>` には `isOpen`/`onToggle` を渡さない。両 props がオプショナルなので型エラーにならず、`DirectoryItem` 側で `isOpen` 未指定時は `true`（全展開）にフォールバック、`onToggle` 未指定時は `?.` で no-op となり、SSR とハイドレーション初期描画が一致する。
  - **型のオプショナル化が必須な理由:** 現状 `SidebarProps` は `onClose?` のみオプショナル。`isOpen`/`onToggle` を必須にすると SSR 経路（`directory.tsx` の `<Sidebar title=... tree=... currentPath=... />`）が型エラーになるため、新規 props はすべてオプショナルにする。
- **理由:** `file-tree-items.tsx` は SSR（`directory.tsx`）とクライアント（`DirectoryApp`）双方から使われる共有コンポーネント。SSR 時は `isOpen` 未指定 → 全展開、クライアントは初回マウント時も空集合 → 全展開、で初期 DOM が一致しハイドレーション不一致を回避できる。`useState(true)` の撤廃で開閉状態の唯一の真実源をフックに集約する。

### 8. `DirectoryApp` でフックを配線

- **対象ファイル:** `src/client/directory-app.tsx`
- **変更内容:**
  - `DirectoryAppProps` に `readonly projectId: string;` を追加（`InitialState` から spread で渡る）。
  - `const fileTree = useFileTreeState(projectId);` を呼び、`<Sidebar ... isOpen={fileTree.isOpen} onToggle={fileTree.toggle} />` として渡す。
- **理由:** `DirectoryApp` がツリーと現在パスを管理する所有者であり、開閉状態フックの配線場所として適切。`projectId` は `entry.tsx` が `hydrate(<DirectoryApp {...state} />)` で spread するため、props 追加だけで伝達される。

### 補足: 変更不要なファイル

- `src/core/file-tree.ts`（`FileTreeNode` 型）: **変更不要**。開閉状態はツリー構造ではなくパス集合（`useFileTreeState` の collapsed）で管理するため、型にフィールド追加は不要。Issue「現状」で列挙されているため明示する。

### 9. 定数の配置

- **対象ファイル:** `src/client/lib/file-tree-state.ts`（ステップ 5 内）
- **変更内容:** `TTL_DAYS = 30` と `FILE_TREE_STATE_KEY` を同ファイルの先頭で `export` 定数として定義。
- **理由:** TTL とキーは永続化ロジックと密結合。`use-sidebar` がキーをフック内に定義するのと一貫し、調整可能性（定数化）の要件も満たす。

## 設計判断

詳細は `adr.md` を参照。

- **ハッシュ方式:** `node:crypto` の SHA-256 先頭 16 hex 文字。サーバー専用ゆえ `src/lib/` に配置。
- **データ構造:** 単一キー `file-tree-state` に `{ [projectId]: { collapsed: string[], lastAccess: number } }`。**閉じているパス集合**を保持しデフォルト全展開と整合。
- **デフォルト挙動:** 永続状態に無いノードは展開（現状維持）。
- **状態持ち上げ:** `DirectoryItem` ローカル state → `useFileTreeState` フックの共有 collapsed 集合へ。props ドリリングで伝播。
- **SSR 整合:** `isOpen` 未指定時フォールバック `true` + クライアント初期 state 空集合で初期 DOM 一致、`useLayoutEffect` でマウント後復元。

## リスクと注意点

- **ハイドレーション不一致:** SSR は全展開、クライアント初回 render も空集合（全展開）で一致させる必要がある。`useFileTreeState` の初期 state を空集合にし、復元は必ず `useLayoutEffect` 内（マウント後）で行う。`useState` の初期化関数内で `localStorage` を読まないこと（SSR との不一致＋SSR では `localStorage` が無い）。
- **SSE tree 更新との両立:** collapsed 集合はパスベースでツリー構造に非依存のため、`setTree` でツリーが差し替わっても開閉状態は保持される。削除されたディレクトリのパスが collapsed に残留しうるが、`isOpen` 判定にしか使われず無害（次回パージ対象にもならないが軽微）。許容する。
- **`projectId` 欠落時の堅牢性:** 万一 `projectId` が空文字でも、store のキーが `""` になるだけで動作はする。ただし `DirectoryApp` props を必須にし、サーバーが常に生成するため通常は発生しない。
- **localStorage 例外:** プライベートブラウジング等で `getItem`/`setItem` が throw しうる。新規コードは try/catch で握りつぶし、永続化失敗時もメモリ上の state で UI は動作させる。
- **パス表現の一貫性:** collapsed に保存するのは `node.path`（ツリーの相対パス）。`currentPath` と同じ相対パス表現であることを確認（`file-tree.ts` の `FileTreeNode.path` は相対パス。SSE 更新後の `fetchTree` も同形式）。
- **複数 `DirectoryItem` が同名パスを持たない前提:** `node.path` はツリー内で一意（相対パス）。キーにも使われており問題なし。

## テスト方針

- 自動テスト（vitest, Node 環境・DOM 非依存）:
  - `src/lib/project-id.test.ts`: 決定性・衝突しないこと・正規化（末尾スラッシュ差異の吸収）。
  - `src/client/lib/file-tree-state.test.ts`: `parseStore`（不正 JSON で空）、`purgeExpired`（TTL 境界）、`getCollapsedSet`、`writeCollapsed`（lastAccess 更新・他プロジェクト非破壊）、`serializeStore` のラウンドトリップ。
- 手動/ブラウザ確認（`testing.md` 参照）:
  - 開閉 → リロードで復元、別ディレクトリ起動で状態が混ざらない、TTL パージ、SSE 更新時の開閉維持、SSR 初期描画のちらつき/コンソール警告無し。

## レビュー履歴

### 1周目
**修正した点**:
- [要件カバレッジ] パージタイミングを明確化: localStorage はサーバーから触れないため「クライアント初期化時のみ」が唯一実現可能、と plan へ追記。
- [アーキ/リスク] `FileTreeNode.path` が `relative()` 由来の相対パスであることをコードで確認し、collapsed 集合のキー一貫性（SSR / SSE 更新 / `currentPath` と同形式）を裏付けた。リスク節の記述と整合。

**取り込んだ改善提案**:
- なし（プロジェクト識別子のサーバー生成・`src/lib` 配置・`node:crypto` 利用可否・既存テストの DOM 非依存パターンは初稿時点で確認済み）。

**見送った提案とその理由**:
- 既存 `sidebar-open`/`theme` キーの名前空間化: Issue 本文でスコープ外と明記されているため見送り。
- ファイルモード/HTML 単体ビューへの適用: ツリーが無い/ハイドレーション無しのため対象外（スコープ節に記載済み）。

### 2周目
両視点とも問題点ゼロ（要件は Issue 本文の全チェック項目を網羅、アーキは `src/core`/`src/lib`/`src/client` のレイヤー規約と純粋関数志向に整合、既存 `use-sidebar` パターンと一貫）で終了。

### 3周目（オーケストレーターによる検証レビュー）
**修正した点**:
- [アーキ/リスク P-001] `isOpen`/`onToggle` を `Sidebar`/`FileTree`/`FileTreeItems`/`DirectoryItem` で**オプショナル props** として定義することをステップ7・ADR-003 に明記。`DirectoryItem` のフォールバックを `const open = isOpen ? isOpen(node.path) : true;`・`onClick={() => onToggle?.(node.path)}` と具体化（SSR 経路の `<Sidebar>` が型エラーにならないようにするため）。

**取り込んだ改善提案**:
- [S-001] フック内に try/catch 込みの `readStore()`/`writeStore()` 薄いラッパを定義し I/O ロジック重複を解消（ステップ6に追記）。
- [要件 S-001] `src/core/file-tree.ts` は変更不要であることを「補足」節に明記。
- [S-002] 初回訪問でも空 collapsed エントリが作られるのが正常である旨を testing.md 項目1に追記。

両視点とも要修正は P-001 の1点のみ（対応方針は正しく実装詳細の明文化）。反映済みで未解決事項なし。
