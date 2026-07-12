# PR Review #001 — feat: persist file tree collapse state in localStorage (#89)

**PR:** #94
**Date:** 2026-06-07
**Round:** 1回目

---

## Summary

- Blockers: 0
- Warnings: 5（うち実修正 2テーマ + テスト追加 1 / 設計判断で見送り 2）
- Notes: 多数（設計の妥当性確認）
- Verdict: **BLOCKED**（Warning を潰すため修正ラウンドへ）

---

## Frontend

### Blockers
- なし

### Warnings
- **[W-001]** `toggle` の `setCollapsed` updater 内で localStorage 副作用（read/write）を実行 — `src/client/hooks/use-file-tree-state.ts:66-78`。state updater は純粋であるべき（CLAUDE.md の純粋関数志向、Preact/React 慣習）。実害は出にくいが原則違反。→ **このPRで修正**（updater 外へ）。
- **[W-002]** `toggle` で書き込み時に `purgeExpired` を通していない — TTL パージは初期化時のみ（plan の設計通り）。→ **設計判断で見送り**（plan ステップ6・ADR-002 と整合、次回マウントでパージ）。

### Notes
- SSR/ハイドレーション整合は正しく設計（SSR 全展開 ↔ クライアント初期空集合が一致、警告なし）。
- props ドリリングは再帰経路含め漏れなく伝播。型オプショナルで SSR 経路も型安全。
- `useLayoutEffect`+`initialMount` は use-sidebar を正しく踏襲。
- `isOpen` の useCallback 依存 `[collapsed]` で再描画が正しくトリガー。
- SSE tree 差し替え後も collapsed 保持（パスベース、ADR-002 通り）。

## Client Logic & Test

### Blockers
- なし

### Warnings
- **[W-001]**（Frontend W-001 と同一）updater 内副作用。→ **このPRで修正**。
- **[W-002]** `parseStore`/`getCollapsedSet` が壊れた `ProjectEntry`（`collapsed` 非配列・`lastAccess` 非数値）に非堅牢 — `src/client/lib/file-tree-state.ts:14-25,50-55`。localStorage は origin 内で書き換え可能。防御的パースを謳う以上、エントリ単位検証が望ましい。→ **このPRで修正**（parseStore でエントリ単位検証＋不正 drop）。
- **[W-003]** 異常系テストの抜け（壊れた ProjectEntry の drop、`parseStore("null")`、purgeExpired の不正 lastAccess）。→ **このPRで修正**（テスト追加）。

### Notes
- 純粋関数群は不変性を維持、`writeCollapsed` の他 projectId 非破壊・空集合保持も担保。
- `purgeExpired` の TTL 境界 `<= ttlMs`（ちょうどは残す）が plan と一致、テスト済み。
- read-modify-write が最新 store を読み直し clobber を回避。try/catch ガードも read/write 両方。
- `createProjectId` の正規化・決定性・非露出はテスト済み。
- フック自体（DOM依存）のテスト無しは plan のテスト方針と整合（抜けではない）。

## Server / Architecture / Security

### Blockers
- なし

### Warnings
- **[W-001]**（Client W-002 と同一）`parseStore` の構造未検証。→ **このPRで修正**。
- **[W-002]** SHA-256 16hex 識別子に salt 無し、予測しやすい絶対パスのため列挙で逆引き可能。ただし peek は localhost バインドのローカルツールで、projectId を取得できる時点で同一 origin アクセス権があり実害は限定的。→ **設計判断で見送り**（ADR-001 に脅威モデルを1行追記）。

### Notes
- `createProjectId` の `src/lib/` 配置はレイヤー規約通り。
- projectId は `createDirectoryRoutes` 冒頭で1度生成、両ルートで共有。
- `dirPath` が絶対パス（`src/index.ts` の resolve 由来）であることを全段確認。
- `DirectoryInitialState` のみに追加、`FileInitialState` 非対象は妥当。
- シリアライズ安全性に新規リスク無し（projectId は純 hex 16文字）。
- レイヤー越境・ドメインロジック漏出なし。

---

## Design Decisions

- W-002（Frontend, purge-on-toggle 省略）: plan ステップ6・ADR-002 の「パージは初期化時のみ」設計に沿うため見送り。
- W-002（Server, ハッシュ salt 無し）: ローカルツールの脅威モデル上、salt 永続化は過剰。ADR-001 に�By注記を追記する。
