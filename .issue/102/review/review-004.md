# PR Review #004 — fix: Ctrl+C でのシャットダウンを有界化し SSE のレースを構造的に塞ぐ

**PR:** #116
**Date:** 2026-07-25
**Round:** 4回目

## Summary

- Blockers: 0
- Warnings: 1
- Notes: 8
- Verdict: **APPROVED**

## レイヤー別ファイル

3 ラウンド目の変更が小さかった（型注釈 1 つ・テストのスタブ追加・コメント圧縮・ドキュメント）ため、2 レイヤーに絞った。

- Code & Test: review-004-code-test.md（B: 0 / W: 0）— APPROVED
- Requirements & Docs: review-004-requirements-docs.md（B: 0 / W: 1）— APPROVED

## 3ラウンド目指摘の解消状況

- Test W-001（手順 3 の回帰ガード）解消 — 手順 3 の削除が 271 passed → 3 failed に変わったことを実測
- Arch W-001（`step()` の型）解消 — `SseManager.shutdown` を async 化すると `src/server/index.ts(237,16)` で typecheck が落ちることを実測
- Arch W-002（テスト都合コメント）解消 — 削られた 3 行の内容がテスト側 `:171-184` に残存していることを確認
- Requirements W-001（観察時間）解消 — 4 分に延長。試行時刻のタイムライン（1→3→7→15→31→61→91→121→151→181 秒）を両クライアント実装から独立に再計算して記載と一致を確認

## 指摘一覧

- [W-001] PR 本文が 4 コミット目（`3aff692`）に未追随（`step()` の条件型化が「変更内容」に無い／テスト表の「手順の順序」行が 3 スタブ・`calls` 4 要素・手順 3 削除の判別性を反映していない） — PR #116 本文

## 仕分け結果

- fix: 1 件（PR 本文。**このラウンド内で修正済み**）
- wont-fix: 0 件（既存の 3 件は継続）
- defer: 0 件

**コード・テストへの指摘はゼロ。** 修正したのは PR 本文のテキストのみで、実装・テスト・計画ドキュメントには一切変更が入っていない。

## 完了判定

**このラウンドでコードに対する `fix` はゼロ**であり、唯一の指摘（PR 本文）はコード変更を伴わないテキスト修正としてラウンド内で解消した。レビューループを **APPROVED** で終了し、Phase 4 のブラウザ検証に進む。

## 特筆事項

- **Code & Test は Warning ゼロに到達。** `step()` の条件型をプローブ 24 種で検証し、`void` / `undefined` / `never` / ジェネリック / オーバーロード / 共用体すべてが通過して**誤検知ゼロ**、拒否側は `() => Promise<void>` / 関数参照 / `async () => {}` / `Promise.resolve()` がすべて `TS2322` / `TS2345` で落ちることを確認。
- 唯一素通りするのは「ブロック本体で promise を捨てる形」（N-001）。手順 4 の中身は Node の `closeAllConnections()`（戻り値 `void` 固定）なので実害なし。
- `pnpm test` を 16 回連続実行して 16/16 で 271 passed。`vi.doMock` の他ファイルへの漏れは別 PID・別ファイルからの import で否定。残留プロセス・フィクスチャともゼロ。
- **ドキュメント 4 点のうち `plan.md` / `testing.md` / `adr.md` の 3 点は実装に完全追随**しており相互の食い違いもゼロ。取り残されていた PR 本文も本ラウンドで解消。
- **`testing.md` の Phase 4 実行可否: Go。** ブラウザ操作を除く記載コマンド（推奨起動・代替起動・計測レシピ・`nix shell nixpkgs#nodejs_24` → v24.18.0・警告の検索キー・`testdata` のパス）をすべて実行して誤りゼロを確認。
- **Phase 5 のスコープ外 Issue 候補**（3 ラウンド目に検出、本 PR の変更とは無関係）: `src/lib/markdown.test.ts` / `src/lib/styles.test.ts` の既存 order dependence（`--sequence.shuffle` で失敗し、単独でも再現する）。
