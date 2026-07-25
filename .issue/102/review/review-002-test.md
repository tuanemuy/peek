# Test Review #002

**Date:** 2026-07-25
**Round:** 2回目

---

## Summary

- Blockers: 0
- Warnings: 2
- Verdict: **APPROVED**

---

## 検証環境と方法

隔離した git worktree（`--detach` で `b8e5da3`）に `pnpm install --frozen-lockfile` して検証した。メインの作業ツリーは本ファイル以外一切触っていない。すべての指摘・確認は**実装を意図的に壊して `vitest run` を走らせ、落ちるべきテストが実際に落ちるか**を実測している。各変異は毎回 `git checkout` で復元し、最終状態が `git status --porcelain` で clean であることを確認した（末尾「最終確認」）。

環境: macOS (darwin 25.4.0) / Node v22.22.1 / vitest 4.1.10 / pnpm 10.34.5。CI は `.github/workflows/ci.yml` で `ubuntu-latest` × Node 22 / 24。

ベースライン: `Test Files 27 passed (27) / Tests 268 passed (268)`。

---

## 1ラウンド目指摘の解消状況

- **[B-001] 解消** — `src/index.shutdown-process.test.ts:147` の `expect(output).toContain("Server stopped")` が入り、無限ハングを実際に判別する。`src/server/index.ts` の `await withTimeout(closing, shutdownTimeoutMs)` の直前に `await new Promise(() => {});` を挿入して `shutdown()` を永久ハングさせると **FAIL**（`Tests 1 failed (1)`、483ms）。失敗メッセージには子プロセスの出力が付き、`┌   Shutting down... ` で止まって `Server stopped. Bye!` が出ていないことが読み取れる。R1 で「同じ変異で 1 passed になる」と実測した穴は塞がった。

- **[W-001] 解消** — `src/lib/with-timeout.test.ts:50` の `leaves no pending timer behind ...` が `process.getActiveResourcesInfo()` でタイマー残存を直接観測する。3 通りの変異すべてで **FAIL**:

  | 変異 | delta | 結果 |
  |---|---|---|
  | 成功側の `clearTimeout` 削除 | 5 | FAIL `expected 5 to be less than 5` |
  | 失敗側の `clearTimeout` 削除 | 5 | FAIL `expected 5 to be less than 5` |
  | 両方削除 | 10 | FAIL `expected 10 to be less than 5` |

  コメントに書かれた予測値（5 / 5 / 10）と実測が完全に一致している。

- **[W-002] 解消** — `src/server/index.test.ts:167-203` の `shutdown step order` が `vi.doMock` で `serve()` をスタブし、手順順序を**同期的に**検証する。2 通りの変異で **FAIL**:
  - `const closing = close();` を `closeAllConnections()` の後ろへ移動 → `expected [ 'closeAllConnections', 'close' ] to deeply equal [ 'close', 'closeAllConnections' ]`
  - `sse.shutdown()` の直前に `await Promise.resolve();` を挿入（= 手順が yield する） → `expected [ 'close' ] to deeply equal [ 'close', 'closeAllConnections' ]`

  R1 で指摘した「判別窓 0〜10ms のレース」も解消されている。`index.test.ts:111-115` のコメントも「`fetch()` は数 ms 後に TCP connect するので *いつ* 閉じたかは言えない」と実態に合わせて書き直され、主張とコードの強度が一致した。

- **[W-003] 解消** — `src/server/routes/sse.test.ts:174-175` が `if (!reader) throw new Error("No reader — the drain gives this its margin")` の fail-fast になり、同一ファイル内の AC-7（`sse.test.ts:111`）と流儀が揃った。

- **[W-004] 解消** — `waitForServer()` に `child.exitCode !== null || child.signalCode !== null` の脱出が入った。`src/index.ts` の `intro()` 直後に `cancel("Port 12345 is already in use"); process.exit(1);` を挿入して子プロセスの即死を再現すると、**20 秒待たず 478ms で** `peek exited before it started listening (code=1, signal=null).` + 子プロセス出力（`└  Port 12345 is already in use`）付きで落ちる。原因が CI ログから読める。

**5 件すべて解消。再指摘なし。**

---

### Test

#### Blockers

なし。

#### Warnings

- **[W-001]** 1 ラウンド目で追加された「手順 2〜4 のエラー分離」に**回帰ガードが 1 つも無い**。この PR が消そうとしている「有界待機に到達しない」形そのものが無検証で通る
  - 場所: `src/server/index.ts:222-242`（`try { sse.shutdown(); watcher.close(); closeAllConnections(); } catch { failure = ... }`）/ 未追加のテスト
  - 理由: 実測で確認した。`try` / `catch` を外して手順 2〜4 の例外がそのまま伝播するようにしても（= 手順 5 の `await withTimeout(closing, ...)` に到達しなくなる）、`pnpm test` は **`Tests 268 passed (268)`**。`throw failure.error` を丸ごと削除して失敗を握りつぶしても同じく **268 passed**。つまりコメントが主張する「whatever fails there, the wait on `closing` still has to happen (and stay bounded)」は自動テストで一切担保されていない。

    そして**このプロパティは既存の `vi.doMock` スタブで安く検証できる**。同じファイルの `shutdown step order` と同じ形で、`close(cb)` がコールバックを呼ばないスタブ + `closeAllConnections()` が throw するスタブを用意し、`startServer(config, { shutdownTimeoutMs: 30 })` で実測した:

    | 実装 | `shutdown()` の所要 | `console.warn` 回数 | reject |
    |---|---|---|---|
    | 現行（エラー分離あり） | **32ms**（予算 30ms 経過後） | **1** | `boom` |
    | `try`/`catch` を外す | **1ms** | **0** | `boom` |

    `expect(elapsed).toBeGreaterThanOrEqual(25)` + `expect(warn).toHaveBeenCalledTimes(1)` の 2 行で判別できる（上表は実際にそのテストを書いて計測した結果で、変異版は `AssertionError: expected 1 to be greater than or equal to 25` で落ちた）。**既にスタブの土台がファイル内にあるので、追加コストは ~20 行**。R1 の W-002 で「順序に回帰ガードが無い」と指摘して実際に足したのと同じ構図が、同じコミットで追加された別の構造的修正にそのまま残っている。
  - 提案: `describe("shutdown step order")` の隣に 1 ケース足す。スタブは既存のものをパラメータ化すれば足りる。

    ```ts
    // 手順 2-4 が throw しても、有界待機と警告は必ず実行される（`src/server/index.ts` の
    // try/catch を外すと 32ms/warn 1 回 → 1ms/warn 0 回になり、ここで落ちる）
    close(_cb?: (e?: Error) => void) {},          // 永久に解決しない
    closeAllConnections() { throw new Error("boom"); },
    ...
    const started = Date.now();
    await expect(instance.shutdown()).rejects.toThrow("boom");
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(warn).toHaveBeenCalledTimes(1);
    ```

    コストが見合わないと判断するなら、plan.md の「間接検証にとどまるもの」に 1 行明記すること（現在この節には AC-2 と AC-8 しか無い）。**「担保されている」と読めるコメントだけが残る状態が一番まずい**のは R1 の W-001 と同じ。

- **[W-002]** `src/index.shutdown-process.test.ts` の内部予算（起動待ち 20s + kill 待ち 10s = 30s）が `testTimeout: 30000` と**完全に一致していて余裕がゼロ**。vitest 側のタイムアウトが先に発火すると `finally` の SIGKILL が走らず、**spawn した `peek` が孤児として残る**
  - 場所: `src/index.shutdown-process.test.ts:114`（`waitForServer(child, port, 20_000, ...)`）/ `:123`（`setTimeout(..., 10_000)`）/ `:163-169`（`finally`）/ `vitest.config.ts:38`（`testTimeout: 30000`）
  - 理由: 予算を足すと 20s + 10s = 30s で `testTimeout` ちょうど。さらに `waitForServer` のループは条件判定が反復の先頭にあるので最大 `20s + 1s`（`AbortSignal.timeout(1_000)`）`+ 150ms` = **21.15s** までオーバーシュートしうる。加えて `waitForServer` を抜けた直後の `sse = await fetch(\`.../sse\`)`（:116）には**タイムアウトが無い**。したがって「起動に時間がかかった」「`/sse` がヘッダを返さない」のいずれでも、テスト自身の診断メッセージ（`peek did not exit after SIGINT.\nOutput:\n...`）に到達する前に vitest のタイムアウトが先に来る。

    そのとき何が起きるかを実測した。`src/index.ts` のシャットダウンハンドラを永久ハング（`setInterval` + `await new Promise(() => {})`）にして:

    | 実行 | 結果 | 子プロセス |
    |---|---|---|
    | `vitest run`（`testTimeout` 30s、既定） | 10.49s で FAIL、メッセージは `peek did not exit after SIGINT` + 出力全文 | **残らない**（`finally` の SIGKILL が効く） |
    | `vitest run --testTimeout=3000`（予算超過を再現） | 3.14s で FAIL（vitest のタイムアウト） | **残る**。vitest 終了後も `node ... src/index.ts .../__test_shutdown_fixture__ --port 52452 --no-open` が生存し続け、3 秒後も生きていた（手動 `pkill` が必要だった） |

    CI ならジョブ終了でコンテナごと消えるが、ローカルではポートを握った peek が無言で残る。そして**どちらの場合も、本来出るはずの診断メッセージが失われる**のが本質的な損失（W-004 の修正で得たものと同じ性質のものを、別経路で失っている）。
  - 提案: どれか 1 つで足りる。
    - `vitest.config.ts` の `testTimeout` を上げるのではなく、テスト側の予算を下げる（起動待ち 20s → 15s など）。孤児化の窓が消えれば十分。
    - `sse = await fetch(...)` に `AbortSignal.timeout(5_000)` を付ける（`waitForServer` 内の `fetch` は既に付いている）。
    - `spawn` した子を `afterEach` でも確実に殺す（テストローカルの `finally` に加えてフック側でも保険をかける）。子が 1 個しかないので `let child: ChildProcess | undefined` をファイルスコープに上げて `afterAll` で `kill("SIGKILL")` するだけでよい。

#### Notes

- **[N-001]** AC-1 のテストは `src/index.ts` の `outro(pc.green("Server stopped. Bye!"))` という**文字列に結合している**。実測: `src/index.ts` から `outro(...)` の 1 行だけを削除すると（`shutdown()` は正常に settle しているのに）AC-1 が `expect(output).toContain("Server stopped")` で落ちる。これは B-001 を塞ぐために意図的に選んだ結合で、テスト側 :136-146 に「なぜこの文字列が settle の証跡なのか」が丁寧に書かれているので、落ちたときに読み解ける。ただし**逆方向のヒントが無い** — `src/index.ts:189` を編集する人には、その行がテストの assert 対象だと分からない。`src/index.ts` 側に 1 行コメント（例: `// この文字列は src/index.shutdown-process.test.ts が shutdown() の完走証跡として assert する`）を足すと将来の誤診（「shutdown が壊れた」と読んでしまう）を防げる。

- **[N-002]** `with-timeout.test.ts` のタイマー検証は判別できているが、**許容幅の設計上マージンが 1 しかない**。片側の `clearTimeout` 削除は delta = 5、閾値は `< rounds` = `< 5`。つまり周囲のタイマーが 1 個でも減っていれば delta = 4 になり、片側削除を見逃す。実測では安定していて、単独実行 12 回・全体実行 4 回の**計 16/16 で `DELTA=0 BEFORE=1`**（`BEFORE=1` は vitest の testTimeout タイマー 1 本。ループ全体が 4ms なので発火も解除も起きない）。現状 flaky ではないが、`toBe(0)` にできない理由（= 周囲のタイマーへの許容）と実際の余裕がコメントの数値からは読み取りにくい。将来 `rounds` を減らす改変が入ると静かに判別性を失う点は認識しておくとよい。

- **[N-003]** **プロセス分離を実測で確認した。** `vitest.config.ts` は `pool` 未指定 = 既定（forks / `isolate: true`）。2 つのダミーテストファイルを同時に走らせて `process.pid` を出力させると `32844` / `32845` と**別プロセス**だった。したがって:
  - `vi.doMock("@hono/node-server")` の影響は `src/server/index.test.ts` の外へ出ない（そもそも `@hono/node-server` を読むのは `src/server/index.ts` とそのテストだけで、`git grep` で確認済み）。ファイル内でも `finally` で `doUnmock` + `resetModules` しており、当該 describe はファイル末尾。
  - `process.getActiveResourcesInfo()` が他のテストファイルのタイマーを拾うことは構造的に起こらない。R2 のレビュー観点として挙がっていた「並行実行による誤検知」は成立しない。

- **[N-004]** 再入ガードの `Promise.withResolvers` 化（`src/server/index.ts:266-268`）は**外部から判別不能**で、テストが無いのは妥当。実測: `shutdownPromise = runShutdown(); return shutdownPromise;` の旧形に戻しても `pnpm test` は 268 passed、スタブで `shutdown()` を同期的に 2 回呼んでも `calls` は `["close","closeAllConnections"]` のまま。理由は `runShutdown()` が最初の `await`（手順 5）で必ず promise を返し、その時点で代入が完了するため、外部から観測できる隙間が無いから。ADR が言う「同期性への依存を消す」構造的価値はあるが、再現条件を作れない以上テスト不能。W-001 と違ってこちらは**テストを足すべきではない**（N-003 相当の扱いでよい）。plan.md の「間接検証にとどまるもの」に 1 行残しておくと将来の読者に親切。

- **[N-005]** **判別性の実測サマリ**（今ラウンドで新規に確認したもの。すべて `git checkout` で復元済み）

  | 変異 | 対象テスト | 結果 |
  |---|---|---|
  | `shutdown()` を永久ハング | AC-1 プロセステスト | **FAIL** `toContain("Server stopped")` |
  | `closeAllConnections()` を無効化 | AC-1 プロセステスト | **FAIL** `expected 2019 to be less than 2000` + 出力に警告 |
  | `outro()` を削除（実装の別部分） | AC-1 プロセステスト | **FAIL**（N-001 の結合。誤診のリスクのみ） |
  | 子プロセスが起動前に即死 | AC-1 プロセステスト | **FAIL** 478ms、原因文字列付き |
  | `close()` を `closeAllConnections()` の後ろへ | 手順順序テスト | **FAIL** 配列が反転 |
  | 手順 2 の前に `await` を挿入 | 手順順序テスト | **FAIL** `[ 'close' ]` |
  | `clearTimeout` 削除（成功側 / 失敗側 / 両方） | タイマー残存テスト | **FAIL**（5 / 5 / 10 vs 閾値 5） |
  | `logger.warn` の呼び出し削除 | AC-3 `warns when ...` | **FAIL** |
  | 警告条件を常に真 | AC-3 `does not warn ...` **+ AC-1 プロセステスト** | **FAIL 2 件**（プロセス層の `not.toContain("did not close within")` も効いている） |
  | `shutdownTimeoutMs` オプションを無視 | AC-3 `warns when ...` | **FAIL** |
  | `delay()` → 手書き `sleep()` に復帰 | AC-8 | **FAIL** `[0,2,0,3,0,4,0,5,0,6] to include 1` |
  | `cleanup()` から `abort()` を除去 | AC-7 | **FAIL** `expected 'expired' to be 'eof'`（566ms） |
  | ② の再チェックを常に真 | AC-8 ほか計 4 ケース | **FAIL 4 件**（positive control が機能） |
  | ① の 503 早期 return を削除 | AC-5 | **FAIL** `expected 200 to be 503` |
  | 手順 2〜4 のエラー分離を撤去 | — | **268 passed**（W-001） |
  | `throw failure.error` を削除 | — | **268 passed**（W-001） |
  | 再入ガードを旧形に戻す | — | **268 passed**（N-004、妥当） |

  AC-1 のプロセステストは 3 種の変異（ハング / `closeAllConnections` 無効化 / 警告混入）を独立した 3 つの assert で拾えており、R1 の「exit code 0 は何も証明しない」状態から明確に改善している。

- **[N-006]** **安定性と後始末は良好。** `pnpm test` を **7 回連続**実行して 7/7 で `Tests 268 passed (268)`（wall 1.68〜1.73s、Duration 1.19〜1.27s）。実行後に確認したもの:
  - 残留プロセス: 0 件（`ps aux | grep -E "src/index.ts|vitest"` が空。`peek . --host 0.0.0.0 --port 3005` は Wed から動いているユーザーの手動プロセスでテスト由来ではない）
  - 残留ファイル: `git status --porcelain` が空。`src/__test_shutdown_fixture__` / `src/server/__test_server_fixture__` ともに消えている
  - 正常系のシャットダウン所要は 8 回計測して **4〜6ms**（閾値 2000ms）。閾値までの余裕は 300 倍以上あり、CI の負荷変動で偽陽性になる余地は無い

  なお `child.once("close", ...)`（`exit` ではなく `close`）を使っているのは正しい選択で、stdio が閉じるまで待つため `output` の取りこぼしが構造的に起きない。

- **[N-007]** **fixture ディレクトリ `src/__test_shutdown_fixture__` の副作用は無い**（実測）。ディレクトリを作った状態で:
  - `pnpm lint` → `Checked 109 files. No fixes applied.`
  - `pnpm format:check` → `Checked 109 files. No fixes applied.`
  - `pnpm typecheck`（tsgo） → エラーなし
  - `pnpm build`（tsdown、entry は `src/index.ts` のみ） → `dist/index.mjs` 130.90 kB、`grep -c "shutdown-process\|__test_shutdown_fixture__" dist/index.mjs` = **0**

  `.gitignore` には無いが `afterAll` で毎回消えるので追跡対象にはならず、既存の `src/server/__test_server_fixture__` と同じ流儀。`src/` 直下という配置も、テスト対象が `src/index.ts`（CLI エントリ）であることに対応していて R1 の「配置」指摘と整合する。ただし W-002 の孤児化パスを踏むと fixture は `afterAll` で消えるのに子プロセスだけがそのディレクトリを見続ける状態になるので、W-002 を直せばここも綺麗になる。

- **[N-008]** **可読性。** `vi.doMock` のスタブ（`index.test.ts:158-166`）は「手順 1〜4 は全部同期なので実ソケット越しの黒箱観測では順序を判別できない。`serve()` をスタブすることで初めて順序が観測可能になる」と *なぜこう書くのか* が書かれていて十分。`getActiveResourcesInfo()` 版（`with-timeout.test.ts:36-49`）も「上のテストは `clearTimeout` を**カバーしていない**」「`unref()` しない判断（ADR-001）ゆえ残タイマーが teardown を遅らせる」「削除時の実測値 5/5/10」まで書かれており、将来壊れたときに意味を読み取れる。AC-1 のプロセステスト（:136-157）も「exit code 0 単独では何も証明しない」「なぜ 5s ではなく 2s なのか」の 2 点が明示されている。R1 の N-006 と同水準の品質が新規テストにも維持されている。

- **[N-009]** **plan.md がコードに追随していない**（AC カバレッジ自体の欠落は無い）。
  - `plan.md:25` の AC-3 は `shutdown({ timeoutMs: 0 })` と書いているが、この API は本コミットで `startServer(config, { shutdownTimeoutMs })` に移された（`plan.md:298` / `:412` / `:571` も同様）。実装は `src/server/index.test.ts:121-139` でカバー済みで、`shutdownTimeoutMs` を無視する変異でちゃんと落ちることも実測した（N-005）ので**カバレッジの穴は無い**。記述だけが古い。
  - `plan.md:401` / `:569` は `src/server/shutdown-process.test.ts` を指すが、ファイルは `src/index.shutdown-process.test.ts` に移動済み。
  - AC-1〜AC-10 のうち自動テストで担保するとされた AC-1〜AC-9 は**すべてテストが存在し、すべて判別性を実測で確認した**（N-005）。API 変更で失われた AC は無い。AC-10 は Phase 4 の手動確認（triage で wont-fix 済み）。

---

## 最終確認

```
（隔離 worktree: /private/tmp/.../scratchpad/wt-test-r2、b8e5da3 detached）

$ git status --porcelain
(出力なし = clean)

$ pnpm test   # 7 回連続
Test Files  27 passed (27)
     Tests  268 passed (268)     ← 7/7 で同一

$ ps aux | grep -E "src/index.ts|vitest" | grep -v grep
(出力なし)

$ ls -d src/__test_shutdown_fixture__ src/server/__test_server_fixture__
No such file or directory  （両方とも残っていない）
```

検証用の変異はすべて `git checkout` で復元済み。使い捨てのプローブテスト（`src/server/__probe.test.ts` ほか）も削除済みで、worktree は clean な状態で `git worktree remove` した。メインの作業ツリーは本ファイル以外一切変更していない。
