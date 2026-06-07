# 実装計画 — Issue #88: ファイル・ディレクトリの検索機能を追加する

**Issue:** #88
**作成日:** 2026-06-07
**複雑度:** 中〜大規模

---

## 目的

ディレクトリブラウジングモードで、サイドバーのファイルツリーからファイル・ディレクトリを名前で検索（フィルタリング）できるようにする。ファイル数が多いディレクトリでも目的のファイルに素早くたどり着けるようにすることがゴール。

## スコープ

### 含まれるもの

- サイドバー上部への検索ボックスの設置
- キーワード部分一致（大文字小文字無視）によるクライアント側フィルタリング
- マッチしたノードの親ディレクトリ保持（パスが分かるように）
- マッチ0件時の「該当なし」表示
- `/` キーで検索ボックスにフォーカスするショートカット
- フィルタ用純粋関数のユニットテスト

### 含まれないもの

- サーバー側検索 API の追加（クライアント側フィルタで完結。大規模ディレクトリの性能問題が顕在化した場合に別途検討）
- 検索結果のハイライト表示
- debounce などの高度なパフォーマンス最適化（`useMemo` による最小限の抑制のみ）
- コンポーネント/フックのレンダリングテスト（プロジェクトに DOM テスト環境が無いため。手動動作確認でカバー）

## 実装ステップ

### 1. フィルタ用純粋関数を追加

- **対象ファイル:** `src/core/file-tree.ts`
- **変更内容:** `filterFileTree(nodes, query): readonly FileTreeNode[]` を追加。`query` を正規化（`trim` + `toLowerCase`）し、空なら入力をそのまま返す。再帰で各ノードを評価する:
  - ディレクトリ: 自身の `name` がマッチ → 配下を全て保持（案A）。マッチしないが子に残存ノードがある → `children` をフィルタ後の配列に差し替えた新ノードを残す。
  - ファイル: `name` がマッチすれば残す。
  - ソート順は `src/lib/file-tree.ts` の `buildFileTree`（`processEntries` 末尾の `nodes.sort`: ディレクトリ優先 → `localeCompare`）で確定済みのため、`filterFileTree` は map/filter のみで順序を保つ（sort しない）。
  - 内部ヘルパ `matchesQuery(node, normalizedQuery)` を一箇所に集約し、将来パス全体対応へ拡張しやすくする。
- **理由:** ステートレス・純粋関数志向に合致し、Vitest のユニットテスト対象にしやすい。配置先は型のみの薄いモジュール `src/core/file-tree.ts`。`filterFileTree` は文字列操作のみで完結させ、クライアントバンドルに含まれても問題ないよう Node 実行時 API に依存する import は持ち込まない（`src/lib/file-tree.ts` は `node:fs` 依存なのでクライアントから import 不可）。

### 2. 検索クエリ state を `DirectoryApp` に追加し、フィルタを適用

- **対象ファイル:** `src/client/directory-app.tsx`
- **変更内容:**
  - `const [searchQuery, setSearchQuery] = useState("")` を追加。
  - `const filteredTree = useMemo(() => filterFileTree(tree, searchQuery), [tree, searchQuery])`（`preact/hooks` の `useMemo`）。
  - `Sidebar` に `searchQuery` / `onSearchChange={setSearchQuery}` / `tree={filteredTree}` / `isSearching`（`searchQuery.trim() !== ""`）を渡す。
  - 検索アクティブ時は折りたたみを無視して全展開したいので、`isOpen` を `isSearching ? () => true : fileTree.isOpen` のように切り替えて渡す。さらに `onToggle` も `isSearching ? undefined : fileTree.toggle` に切り替え、検索中の不可視トグル（localStorage 折りたたみ state の汚染）を防ぐ。
- **理由:** 既存の `useState` ベースのローカル state 管理パターンに沿う。`tree` は SSE で更新されうるので `useMemo` の依存に含めて再フィルタする。

### 3. `Sidebar` に検索ボックスと「該当なし」表示を追加

- **対象ファイル:** `src/components/navigation/sidebar.tsx`
- **変更内容:**
  - props に `searchQuery?`, `onSearchChange?`, `isSearching?` を追加（全て optional にして SSR で未指定でも壊れないように）。
  - `header` の下・スクロール領域 div の**外**（固定位置）に検索 `<input>`（`id="sidebar-search"`, `type="search"`, `placeholder`, `value={searchQuery ?? ""}`, `onInput`）を配置。長いツリーをスクロールしても検索ボックスが消えないようにする。`/` ショートカットのフォーカス対象になるよう固定 `id` を付与。
  - `nav` 内で `isSearching && tree.length === 0` の場合に「該当なし」メッセージを表示、そうでなければ従来通り `FileTree` を描画。
- **理由:** 受け入れ条件「検索ボックス表示」「該当なし状態」を満たす。presentational のまま props 駆動を維持。SSR では `searchQuery=""`（フィルタ無効）で描画され hydrate 初回描画と一致する。

### 4. `/` フォーカス用ショートカット hook を追加

- **対象ファイル:** 新規 `src/client/hooks/use-search-shortcut.ts`
- **変更内容:** `useEffect` で `window` に `keydown` リスナを登録。`/` 押下時に、フォーカスが入力系要素（`input`/`textarea`/`select`/`contentEditable`）に無いこと・IME変換中（`isComposing`）でないことを確認し、`event.preventDefault()` してサイドバーを開くコールバック（任意）を呼んだ後 `document.getElementById("sidebar-search")?.focus()`。cleanup でリスナ解除。
- **理由:** クライアント専用の副作用。`use-sidebar.ts` の「DOM を `getElementById` で直接触る」既存パターンに合わせる。`DirectoryApp` から `useSearchShortcut(...)` を呼ぶ。

### 5. フィルタ関数のユニットテストを追加

- **対象ファイル:** 新規 `src/core/file-tree.test.ts`
- **変更内容:** `filterFileTree` のテスト（空クエリで全件 / 大文字小文字無視 / ファイル名部分一致 / ディレクトリ名マッチで子保持（案A固定）/ 孫マッチで親パス保持 / マッチ無しで空配列 / 入力配列・ノードの非破壊 / 順序維持）。
- **理由:** 受け入れ条件「テストを追加」を満たし、プロジェクトのユニットテスト規約に合致。

### 6. 品質チェック

- **対象ファイル:** 全変更
- **変更内容:** `pnpm typecheck`、`pnpm lint:fix`、`pnpm format`、`pnpm test` を実行。
- **理由:** CLAUDE.md の Code Quality 規約。

## 設計判断

- **検索対象:** ファイル/ディレクトリの `name` を基本とする（パス全体ではなく）。Issue 本文も「名前で検索」が主題。内部マッチャを一箇所に集約し将来拡張しやすくする。詳細は adr.md 参照。
- **親パス保持アルゴリズム:** ボトムアップ再帰。ディレクトリ自身がマッチしたら配下を全保持（案A）、マッチしなくても子に残存があれば親を残す。詳細は adr.md 参照。
- **検索中の折りたたみ状態:** 検索アクティブ時は `isOpen` を常に `true` にして全展開で見せ、マッチへのパスを可視化。検索クリア後は元の折りたたみ状態に戻す（state を破壊せず `isOpen` を差し替えるだけ）。
- **`/` ショートカット:** グローバル `keydown`。入力要素フォーカス時・IME変換中は無効化。サイドバーが閉じている場合はフォーカス前にサイドバーを開く。

## リスクと注意点

- **SSR/ハイドレーション整合:** 検索ボックスは SSR でも描画される。`searchQuery` 初期値を空にし SSR時フィルタ無効・全件表示にすることで hydrate 初回描画と DOM を一致させる。SSR側 `Sidebar` 呼び出しは新 props を渡さなくても optional なので壊れない。
- **折りたたみ state との競合:** 検索中は `isOpen=true` 固定で見た目は全展開のまま。検索クリア後の状態を動作確認で確認。
- **`/` ショートカットの誤発火:** `target` が編集可能要素かを必ず判定。IME 変換中（`isComposing`）も無視。
- **パフォーマンス:** 大規模ツリーで毎キーストロークにフィルタが走る。`useMemo` で抑制。将来的な debounce は今回スコープ外。
- **クライアントバンドル安全性:** `filterFileTree` は文字列操作のみで完結させ、Node 実行時 API を必要とする import を持ち込まない（クライアントバンドルに含まれるため）。`src/core/` 全体が Node 非依存というわけではない点に注意（`src/core/path.ts` は `node:path` を使う）が、`filterFileTree` 自体は純粋な文字列・配列操作で足りる。
- **検索中の SSE 更新:** 検索アクティブ中に SSE（`onTreeUpdate`/`setTree`）でツリーが更新されると `useMemo` 依存 `tree` により自動再フィルタされる。マッチしていたノードが消えてマッチ0件になれば「該当なし」に遷移する。この挙動は手動動作確認で確認する。

## テスト方針

- 中心は `src/core/file-tree.test.ts` の純粋関数ユニットテスト（DOM テスト環境が無く全テストがユニットテストである実態に合わせる）。空クエリ全件 / 大小文字無視 / ファイル名部分一致 / ディレクトリ名マッチ時の子保持 / 孫マッチ時の親パス保持 / マッチ無しで `[]` / 非破壊 / ソート順維持を網羅。
- コンポーネント/フックのテストは前例が無く DOM 環境導入はスコープ拡大になるため追加しない。「該当なし」分岐・`/` ショートカット・hydrate 整合は手動動作確認でカバー。
- 既存テストが壊れないことを `pnpm test`、型安全を `pnpm typecheck` で担保。

## レビュー履歴

### 1周目: 両視点（要件カバレッジ / アーキ・リスク）

**修正した点**:
- [P-001]（両視点）: `buildFileTree` の所在を `src/core/file-tree.ts` から `src/lib/file-tree.ts` に正しく訂正。`filterFileTree` の配置先（`core`）は変更なし。ソート順の根拠記述を正確化。
- [P-002]（アーキ視点）: 「`core` は Node 非依存」という誤った根拠を訂正（`src/core/path.ts` は `node:path` を使う）。クライアントバンドル安全性の観点で「`filterFileTree` は文字列操作のみで完結させる」に根拠を置き換え。

**取り込んだ改善提案**:
- [S-001]（アーキ視点）: 検索中は `onToggle` も `undefined` に切り替え、不可視の localStorage 汚染を防ぐ（ADR-005 を追加）。
- [S-002]（アーキ視点）: 検索ボックスをスクロール領域の外（固定位置）に配置することを明示。
- [S-003]/[S-002]（両視点）: 検索中の SSE 更新でマッチ0件に遷移するケースをリスク欄・動作確認に追記。
- [P-002]（要件視点）: 実ツリーに空ディレクトリが現れない前提を ADR-003 とテスト方針に明記。

**見送った提案とその理由**:
- [S-001]（要件視点）: `/` ショートカットの優先度明示。Issue 本文で言及されており妥当なスコープのため必須として実装する（後回しにしない）。

両視点とも方針自体への異論（ブロッカー）はゼロ。指摘は文面の事実誤認訂正と小改善で、すべて反映済み。2周目は不要と判断し計画を確定する。
