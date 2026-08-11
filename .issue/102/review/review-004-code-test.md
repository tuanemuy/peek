# Code & Test Review #004

**Date:** 2026-07-25
**Round:** 4回目
**対象:** PR #116 (`issue/102/fix-shutdown-hang`, HEAD `3aff692`) / Issue #102
**参照:** `.issue/102/plan.md`, `.issue/102/adr.md`, `.issue/102/review/review-003-test.md`, `.issue/102/review/review-003-arch-typesafety.md`, `.issue/102/review/triage.md`, `CLAUDE.md`

---

## 検証環境と方法

隔離した git worktree（`--detach` で `3aff692`、`pnpm install --frozen-lockfile`）で検証した。メインの作業ツリーは本ファイル以外一切触っていない。事実主張はすべて実測（typecheck プローブ 24 種 / フォールト注入 10 件 / `pnpm test` 16 連続 / `process.getActiveResourcesInfo()` の親コミットとの対照）で裏を取っている。変異は毎回 `git checkout -- src/` で復元し、最終 `git status --porcelain` が空であることを確認した。

環境: macOS (darwin 25.4.0) / Node v22.22.1 / vitest 4.1.10 / pnpm 10.34.5 / tsgo。
ベースライン: `Test Files 27 passed (27) / Tests 271 passed (271)`、`pnpm typecheck` / `pnpm lint` / `pnpm format:check` すべて緑（`Checked 109 files. No fixes applied.`）。

---

## Summary

- Blockers: 0
- Warnings: 0
- Notes: 4
- Verdict: **APPROVED**

**今回の 3 つの修正はいずれも何も壊していない。** `step()` の条件型は現在の 3 手順を素通しさせたまま `Promise` を返す手順を実際に typecheck で拒否し、`vi.doMock("../lib/watcher.js")` は他のテスト（同ファイル内・他ファイルとも）に影響せず、`calls` の 4 要素化で順序テストは**弱くならず強くなった**（手順 3 の削除・移動・`step()` 剥がしのすべてが落ちるようになった）。Note は 2 件が「今回の修正の効き方の限界」の記録、2 件が実測サマリで、いずれも修正を求めるものではない。

---

## 3ラウンド目指摘の解消状況

- **[Test W-001] 解消** — 手順 3（`watcher.close()`）が両方向で検証されるようになった。R3 で「削除しても 271 passed」だった変異は**いま 3 failed**（実測）。加えて逆方向（`step()` を剥がす / 手順 4 と入れ替える / 手順 2 と入れ替える）もすべて落ちる。`withStubbedServer` の docstring も「recording steps 1-4 in `calls`」に直り、`ServerInstance.shutdown` の doc が謳う 4 つの契約と実体が一致した。エラー注入も、実運用で最も throw しうる `FSWatcher.close()` 側（`onWatcherClose`）に移っている。

  | 変異 | R3 | R4 |
  |---|---|---|
  | 手順 3 を丸ごと削除 | **271 passed**（穴） | **3 failed** — `expected [ 'close', 'sse.shutdown', …(1) ] to deeply equal […(2) ]` × 3 ケース |
  | 手順 3 の `step()` を剥がす（`watcher.close();`） | （当時は無検証） | **1 failed** — `aggregates two failing steps…` が `calls` 3 要素で落ちる |
  | 手順 3 を手順 4 の後ろへ移動 | （当時は無検証） | **3 failed** |
  | 手順 2 と手順 3 を入れ替え | （当時は無検証） | **3 failed** |

- **[Arch W-001] 解消** — `step()` が `<T>(run: () => T extends PromiseLike<unknown> ? never : T)` になり、**プロダクションコードが実際に型で落ちる**ことを production 側の変異で確認した。

  | 変異 | typecheck の結果 |
  |---|---|
  | `SseManager.shutdown` を `() => Promise<void>` に（手順 2） | `src/server/index.ts(237,16): error TS2322: Type 'Promise<void>' is not assignable to type 'never'.` |
  | `FileWatcherHandle.close` を `() => Promise<void>` に（手順 3） | `src/server/index.ts(239,16): error TS2322: …` |

  R3 で「プロダクションコードは素通りする」と実証された経路が、いま**プロダクション側の行番号で**落ちる。ADR-002 / ADR-009 にも改訂が記録されている。限界は N-001 に記す。

- **[Arch W-002] 解消** — `src/index.ts:189` が `// "Server stopped" is asserted by src/index.shutdown-process.test.ts.` の 1 行になった。削られた 3 行の内容（`outro()` の位置 / exit code 0 では判別できない理由 / 実測「ハングした `shutdown()` は exit 0 / 6ms で『Server stopped』が出ない」）は `src/index.shutdown-process.test.ts:171-184` に**そのまま全部残っている**（読んで確認）。プロダクション → テストの逆方向の辿り先も 1 行で保たれており、**失われた情報は無い**。R3 の N-001 が「残すべき」とした `logger.info` の why コメント（`^C` エコーとの分離 / 再発時の切り分け、`src/index.ts:179-181`）も手つかずで残っている。

---

### Code & Test

#### Blockers

なし。

#### Warnings

なし。

#### Notes

- **[N-001]** **`step()` の条件型は「式本体のアロー関数」に対してのみ効く。ブロック本体（＝現在の手順 4 の形）で promise を捨てた場合は型エラーにならない。** 今日壊れてはいないので指摘ではなく記録。

  隔離 worktree でプローブ 24 種を tsgo にかけた実測（`src/server/index.ts` と同一の `step` 定義を使用）:

  | # | 渡した式 | 結果 | 期待 |
  |---|---|---|---|
  | P01-P11 | `() => syncVoid()` / `syncVoid` / `() => {}` / `() => undefined` / `() => 1` / `() => never` / `() => ({a:1})` / 現手順 4 と同形のガード付きブロック ほか | **すべて通る** | ○（意図せず弾くケースは 0 件） |
  | N01 | `() => asyncVoid()` | `TS2322: Type 'Promise<void>' is not assignable to type 'never'.` | ○ |
  | N02 | `asyncVoid`（関数参照） | `TS2345` | ○ |
  | N03 | `async () => {}` | `TS2345` | ○（最も起こりそうな取り違え） |
  | N04 | `async () => { await asyncVoid(); }` | `TS2345` | ○ |
  | N05 | `() => Promise.resolve()` | `TS2322` | ○ |
  | Q02-Q06 | ジェネリック `() => genericId(1)` / オーバーロード `() => overloaded(1)` / `genericId<void>` / 共用体 `() => unionSync()` / `() => optionalReturn()` | **すべて通る** | ○（誤検知なし） |
  | **R01** | 現手順 4 と同形のブロック本体で、中の `closeAllConnections()` が `Promise<void>` を返す | **通ってしまう** | × |
  | **R02** | `() => { asyncVoid(); }`（ブロック本体で promise を捨てる） | **通ってしまう** | × |
  | **R03** | 戻り値 `void \| Promise<void>` の関数参照 | **通ってしまう** | × |
  | **R04** | 戻り値 `any` | **通ってしまう** | ×（`any` なので当然） |

  **重要なのは「意図せず弾くケースが 1 件も無かった」こと**（P01-P11 / Q01-Q06 が全通過、`void` / `undefined` / ジェネリック / オーバーロード / 共用体すべて OK）。一方で、アロー関数の戻り値型が `void` に落ちる形（ブロック本体）は TypeScript の「戻り値 `void` の関数型には任意の戻り値の関数が代入できる」規則が先に働くため、条件型に到達しない。

  現在の 3 手順のうち**手順 2 / 3 は式本体なので守られており**（上の Arch W-001 の実測がその証拠）、守られていないのは**ブロック本体で書かれている手順 4 だけ**である。手順 4 の中身は Node の `http.Server.closeAllConnections()`（`@types/node` で `void` 固定）なので、非同期化される現実的な経路は無い。`biome` に floating-promise 系のルールは有効化されていない（`biome.json` は `recommended: true` のみ、当該ルールは nursery）ことも確認した。

  したがって修正不要だが、`src/server/index.ts:219-222` のコメント「A step must be synchronous: … The conditional type is what rejects it」と ADR-002 の記述は、**式本体に限っての話**である点だけ実態より強い。気になるなら手順 4 を式本体（`step(() => ("closeAllConnections" in server ? server.closeAllConnections() : undefined))`）にすれば揃うが、可読性を落としてまでやる価値は無いと判断する。**別 Issue にする話でもない。**

- **[N-002]** **`onWatcherClose` を注入したケースで、実物の `watcher.close()` が呼ばれずに `fs.watch` ハンドルが 1 個残る。** 実測で親コミットとの差分を確認した。

  `withStubbedServer` の watcher スタブは `actual.createFileWatcher()`（＝**実物**）を作ってから `close` だけを差し替えており、`stubs.onWatcherClose` があるときは `return` して実物の `close()` に委譲しない（`src/server/index.test.ts:243-250`）。既存の SSE スタブと同型なので設計としては一貫しているが、`SseManager` と違って `FileWatcherHandle` は OS ハンドルを握っている。

  `src/server/index.test.ts` の末尾に `process.getActiveResourcesInfo()` を出すプローブを足して対照実験した:

  | コミット | ファイル終了時点の残存ハンドル |
  |---|---|
  | 親 `5a44ecd` | `["PipeWrap"×4, "FSEventWrap"×1, "Timeout"]` |
  | 本 `3aff692` | `["PipeWrap"×4, **"FSEventWrap"×2**, "Timeout"]` |

  増えた 1 個が `aggregates two failing steps…`（`onWatcherClose` が throw するケース）由来である。実害はほぼ無い —— `afterAll` の `rmSync` でフィクスチャが消えると `src/lib/watcher.ts:39-41` の `rename` 分岐が自前で `watcher.close()` を呼ぶため自己解消するし、`pnpm test` を 16 回連続で走らせても遅延・ハング・vitest の残存プロセス警告は一度も出ていない。ただし「スタブの緩さ」としては唯一見つかった実物との乖離なので記録する。潰すなら 1 行:

  ```ts
  close: () => {
    calls.push("watcher.close");
    watcher.close();          // 実物のハンドルは常に解放する
    stubs.onWatcherClose?.();  // その上で失敗を注入する
  },
  ```

  なお**スタブ全体の忠実度は高い**。差し替えているのは `close` の 1 メソッドだけで、`createFileWatcher()` 本体・`watchFile()` による実 `fs.watch` の登録・`setupWatcher()` の分岐・`startServer()` 本体・`runShutdown()` の手順並び・`step()` の捕捉・`failures` の集約・`withTimeout` はすべて実物が走る。「スタブの挙動だけを見ている」テストは今回も見つからなかった（下の N-003 で production 側 8 変異すべてが捕捉されている）。

- **[N-003]** **判別性の実測サマリ（今ラウンドの 10 変異。すべて復元済み）。`calls` の 4 要素化で順序テストは弱くなっていない — 逆に手順 3 の 3 方向の変異を新たに捕捉するようになった。**

  | # | 変異 | 結果 | 捕捉したメッセージ |
  |---|---|---|---|
  | M-A | 手順 3 を削除 | **3 failed** | `expected [ 'close', 'sse.shutdown', …(1) ] to deeply equal […(2) ]` |
  | M-B | 手順 3 の `step()` を剥がす | **1 failed** | `aggregates two failing steps…` の `calls` |
  | M-C | 手順 3 を手順 4 の後ろへ | **3 failed** | `calls` の並び |
  | M-F | 手順 2 と手順 3 を入れ替え | **3 failed** | `calls` の並び |
  | M6 | 手順 2 を削除 | **3 failed** | `calls` の並び |
  | M8 | 手順 4 を削除 | **6 failed** | プロセステスト `expected 2573 to be less than 2000` / `does not warn…` / `calls` 4 件 |
  | M1 | `step()` の try/catch を撤去 | **3 failed** | `expected shutdown() to reject…` ほか |
  | M16 | `failures` の throw を手順 5 の前へ | **2 failed**(+ 無関係 1) | **`expected 0 to be greater than or equal to 25`**（`elapsedMs` の 1 行だけが判別、R3 と同じ） |
  | M-D | 手順 3 と手順 4 の間に `await Promise.resolve()` を挿入 | **1 failed** | `shutdown step order`（AC-4 の「最初の `await` の前」契約） |
  | M-E | 手順 1 と手順 2 の間に `await Promise.resolve()` を挿入 | **1 failed** | 同上 |

  型側の判別性（typecheck）も production 変異 2 件で確認済み（Arch W-001 の表）。

- **[N-004]** **安定性・後始末・AC カバレッジはすべて良好。**
  - **安定性**: `pnpm test` を 6 回 + `pnpm vitest run` を 10 回、計 **16 回連続**で `Test Files 27 passed (27) / Tests 271 passed (271)`（Duration 1.25〜1.62s）。`pnpm typecheck` / `pnpm lint` / `pnpm format:check` も緑。
  - **`vi.doMock` の漏れ**: `vitest.config.ts` は `pool` 未指定 = 既定（vitest 4.1.10 は `forks` / `isolate: true`）。プローブ 2 ファイルを同時実行して `process.pid` が **58800 / 58805** と別プロセスであること、別ファイルから `import("./lib/watcher.js")` してもモックされた実装（`calls.push` を含む）が返らないことを実測した。`../lib/watcher.js` は `src/server/index.test.ts` からも `src/server/index.ts` からも同じ `src/lib/watcher.ts` に解決される（M-A 等の変異が実際に効いていることが証拠）。`vi.doMock` は巻き上げられないので、ファイル前半の実ポートを使う `startServer / shutdown lifecycle` 群（静的 import 経由）には影響しない。`doUnmock` × 3 + `resetModules` は `try`/`finally` にあり、`startServer()` が throw しても `run()` が throw しても必ず走る。`src/lib/watcher.ts` を import／モックする他のテストファイルは存在しない（`grep -rln "lib/watcher" src/` は `src/server/index.ts` と `src/server/index.test.ts` の 2 件のみ）。
  - **残留**: `git status --porcelain` が空、`src/__test_shutdown_fixture__` / `src/server/__test_server_fixture__` / `src/lib/__test_fixture__` いずれも存在せず、`ps -eo pid,command | grep -E "src/index\.ts|vitest|__test_"` に本 worktree 由来のプロセスは 0 件。worktree は `git worktree remove` 済み。
  - **AC カバレッジ**: `plan.md` の AC-11 新設と AC 表・テスト方針表への追随を確認した。自動テストで担保するとされた **AC-1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9 / 11 のすべてにテストが存在し、今ラウンドまたは R3 で判別性が実測されている**。AC-11 の「手順 2 / 3 / 4 のいずれが throw しても」は、手順 2 = 1 ケース目（`onSseShutdown`）、手順 3 = 2 ケース目（`onWatcherClose`）、手順 4 = 2・3 ケース目（`onCloseAllConnections`）で 3 手順とも埋まっている。AC-10 は Phase 4 の手動確認（triage で wont-fix 済み）。テスト方針表の「実ポート + `serve()` / `SseManager.shutdown()` / `createFileWatcher()` スタブ」「`calls` の 4 要素」という記述も実装と一致している。
  - **参考（PR 対象外）**: 変異検証中の 1 回だけ `src/lib/file-tree.test.ts > uses relative paths` が落ちた。同ファイルは `gh pr diff 116 --name-only` に含まれず、単独で 20 回・全体で 16 回走らせても再現しない。R3 の N-005 が記録した `markdown.test.ts` / `styles.test.ts` の既存 flake と同種の、本 PR とは無関係な事象と判断する。

---

## 最終確認

```
（隔離 worktree: /private/tmp/.../scratchpad/wt-ct-r4、3aff692 detached）

$ git status --porcelain
(出力なし = clean)

$ pnpm test   # 6 回 + pnpm vitest run 10 回
Test Files  27 passed (27)
     Tests  271 passed (271)     ← 16/16 で同一

$ pnpm typecheck && pnpm lint && pnpm format:check
（エラーなし / Checked 109 files. No fixes applied.）

$ ps -eo pid,command | grep -E "src/index\.ts|vitest|__test_" | grep -v grep
（0 件）

$ git worktree remove --force .../wt-ct-r4
（削除済み。子プロセスの残留も 0 件）
```

変異 10 件・型プローブ 2 ファイル・残存ハンドルプローブはすべて `git checkout -- src/` および `rm` で撤去済み。メインの作業ツリーは本ファイル以外一切変更していない。
