# Architecture & Type Safety Review #003

**Date:** 2026-07-25
**Round:** 3回目
**対象:** PR #116 (`issue/102/fix-shutdown-hang`, HEAD `5a44ecd`) / Issue #102
**参照:** `.issue/102/plan.md`, `.issue/102/adr.md`(ADR-001〜009), `.issue/102/review/review-002-arch-typesafety.md`, `.issue/102/review/triage.md`, `CLAUDE.md`

検証したもの: `gh pr diff 116` 全差分、`src/server/index.ts` / `src/server/routes/sse.ts` / `src/lib/with-timeout.ts` / `src/index.ts` / `src/server/index.test.ts` / `src/index.shutdown-process.test.ts` 全文、`.issue/102/adr.md` / `plan.md` 全文、`tsconfig.json`、`node_modules/typescript/lib/lib.es2021.promise.d.ts`、`node_modules/hono/dist/utils/stream.js`（`StreamingApi.abort()` の実装）。
実行したもの: `pnpm typecheck` / `pnpm lint` / `pnpm test`（**27 files / 271 tests all pass**）、隔離 worktree（`--detach`）でのフォールト注入 2 件（W-001 の実証、`step()` の型プローブ 2 種）。**作業後 `git worktree remove` 済み。**

---

## Summary

- Blockers: 0
- Warnings: 2
- Notes: 6
- Verdict: **APPROVED**

**全体評価**: 2 ラウンド目の Warning 6 件は**全件解消**している。特に W-002（配置根拠の事実誤り）は「誤った根拠を別の根拠に差し替える」ではなく **「実測したら結論は『どちらでも壊れない』だった」と書き切って、根拠をコードコメントから撤去する**という形に落ち着いており、指摘の趣旨を超えて正しい。W-005 / W-006 の文書メンテナンスも機械的な追随ではなく、`plan.md` 側に「実装レビューで撤回/反転した」という 1 行が入って**判断の履歴が両文書から辿れる**状態になった。

今回の指摘は 2 件だけで、どちらも「今直すべき小さな改善」である。W-001 は `step()` ヘルパが**この PR 自身が消そうとしている「同期実行だから安全」依存を 1 つ新規に導入している**という指摘で、フォールト注入で実証した。W-002 はコメント 4 行の削除。設計の作り直しを求める指摘は無い。

---

## 2ラウンド目指摘の解消状況

- **[W-001]** 失敗チャネルの上書き（手順 2〜4 のエラーが `closing` の reject に消される） → **解消**。`src/server/index.ts:218` が `const failures: unknown[] = []` になり、手順 5 も `try`/`catch` で包まれて `failures.push(error)`（`:256-258`）。1 件はそのまま throw / 2 件以上は `AggregateError`（`:260-265`）。R2 で実証した「`STEP3-FAILED` が消える」経路は、`src/server/index.test.ts:352-364` の "collects a rejection from the bounded wait alongside an earlier failure" が回帰ガードとして塞いでいる（実測: `AggregateError.errors` が `["socket boom", "close boom"]`）。ADR-002:173-184 に、旧構造の実測・`AggregateError` を選んだ理由・`Result` / `TimeoutOutcome` 3 分岐を却下した理由が並べて記録されている。
- **[W-002]** `src/lib/` 配置根拠が「事実として誤った基準」 → **解消（かつ指摘以上）**。`src/lib/with-timeout.ts:1-5` からバンドル論拠が消え、`Why \`src/lib/\` and not \`src/core/\`: see \`.issue/102/adr.md\` ADR-001.` の 1 行だけになった。ADR-001:85-108 は**採用しなかった 2 つの根拠（副作用の有無 / バンドルが太る）を「なぜ誤りか」つきで記録し**、正しい結論は「どちらでも壊れない」であると書き、だから恒久コメントには書かないという判断まで残している。R2 の提案（「片側専用だから `src/lib/`」）を採らず、実測（`src/core/error.ts` / `path.ts` / `result.ts` はクライアントから 1 度も import されていない = `src/core/` は共有層ですらない）で**その提案の前提ごと否定している**のは正しい。
- **[W-003]** `StartServerOptions.shutdownTimeoutMs` の doc → **解消**。`src/server/index.ts:44-49` が `Defaults to 2,000ms.`（非 export const 名ではなく実数）と `A non-positive value (or \`NaN\`) means "give up immediately and warn" — it does *not* mean "wait forever".` を含む。R2 の提案どおり。
- **[W-004]** コメント総量 → **解消**。実測（`grep -cE '^\s*(//|/\*|\*)'`）で `src/server/index.ts` 45→41、`src/server/routes/sse.ts` 28→25、`src/lib/with-timeout.ts` 25→23、計 **98→89**。指摘した 2 ブロックが両方縮んでいる: `src/server/index.ts:273-275` は「この PR がやめようとしている物語」の後半が消えて 3 行、`src/server/routes/sse.ts:85-89` は ADR-003 の丸写し 3 行が消えて `See .issue/102/adr.md ADR-003.` に置き換わった。評価は N-006 に書く。
- **[W-005]** ADR 内の旧手順番号 → **解消**。`grep -nE '手順 [0-9]' .issue/102/adr.md` の全ヒットを確認したが、`close()` を指す箇所は**すべて「手順 1」**（`:212` / `:274` / `:517` / `:521`）。指摘した 4 箇所が全部直っている。`plan.md:66`（R2 で指摘した同種の残存）も現在は該当記述が無い。
- **[W-006]** `plan.md` の実装との乖離 → **解消**。実測で確認した:
  - 型述語 `isHttpServer`: `plan.md:60` / `:117` / `:320` / `:553` / `:579` すべてが「実装レビューで撤回した」に書き換わっている。
  - `watcher`: `:61` / `:316` / `:552` / `:580` すべてが「削除」に反転済み（`:61` は「当初『残す』判断だったが実装レビューで削除に反転した」と経緯つき）。
  - ADR 一覧: `:583` に ADR-008、`:584` に ADR-009 が追加され、`:576-584` が ADR-001〜009 の全件を網羅している。
  - `:184` の `Result` 却下根拠から、R2 N-001 で指摘した誤り（「`TypedError` は `cause: Error` を必須とするから」）が消え、「`Result` は成否の語彙、タイムアウトは期待される分岐」＋「リポジトリ内の `E` は全て `TypedError` 派生」という正しい理由に置き換わっている。
  - さらに `:344`（失敗チャネルを配列にする）/ `:427`（`step()` と `AggregateError`）/ `:600`（`AggregateError` になることの影響）が今ラウンドの実装変更に追随して新規に入っている。

---

### Architecture & Type Safety

#### Blockers

- なし。

#### Warnings

- **[W-001]** **`step(run: () => void)` は非同期な手順を型で拒めず、渡された場合に「失敗が `failures` に載らない」「手順 5 より前に完了しない」「unhandled rejection になる」の 3 つが同時に起きる。** この PR 自身が ADR-001 / ADR-009 で消そうとしている「同期実行だから安全」依存を、`step()` が 1 つ新規に持ち込んでいる。**今直すべき小さな改善**（型注釈 1 行）。
  - 場所: `src/server/index.ts:219-225`（`const step = (run: () => void) => {...}`）/ `:233` / `:235` / `:242-246`
  - 問題: TypeScript は戻り値型 `void` の位置に任意の戻り値を許す。したがって `sse.shutdown()` / `watcher.close()` / `server.closeAllConnections()` のいずれかが将来 `Promise<void>` を返すようになっても、`step(() => sse.shutdown())` は**型エラーにならない**。`run()` は throw しないので `catch` は空振りし、返された promise は誰も掴まない。
  - 実証（隔離 worktree でフォールト注入。実施後に `git checkout --` で撤去し、worktree も削除済み）: `SseManager.shutdown` を `() => Promise<void>` にし、本体を `await Promise.resolve()` の後に throw させた。

    | 検証項目 | 結果 |
    |---|---|
    | `pnpm typecheck`（`src/server/index.ts` について） | **エラーなし**。唯一の型エラーは `src/server/index.test.ts:217` のスタブ側で、プロダクションコードは素通りする |
    | `pnpm lint`（biome） | **エラーなし**（109 files checked） |
    | `await instance.shutdown()` | **resolve する**（失敗が報告されない） |
    | `process.on("unhandledRejection")` | **`["ASYNC-STEP-FAILED"]` を捕捉** |

    CLI（`src/index.ts:186-188`）は `server.shutdown()` を `try`/`catch` しているが、resolve してしまうので `logger.error` には何も出ない。一方 Node 22 の既定は `--unhandled-rejections=throw` なので、実プロセスでは**シャットダウン中に uncaught でクラッシュする**（AC-1 の「exit code 0」を直接壊す）。さらに `shuttingDown` フラグが手順 4 より後に立つことになり、ADR-002 の順序保証と AC-4（手順 1〜4 は最初の `await` より前に完了する）も同時に崩れる。既存の回帰ガード（`src/server/index.test.ts` "shutdown step order"）は**これを検出できない** — スタブが `calls.push()` を同期的に行うため、実体が非同期になっても配列は同じになる。
  - なぜ Warning か: 現在の 3 手順はすべて `void` 戻りなので**今日は壊れていない**。壊れるのは「将来どれかが async 化されたとき」だけである。ただし本 PR の主題はまさにそれで、ADR-009:639 は選択肢 a（コメントで不変条件を書くだけ）を **「守らせる手段がレビュアーの目しかないので採らない」** として却下している。`shutdown()` の再入ガードに適用した基準を、同じ関数内の `step()` に適用しないのは一貫性を欠く。CLAUDE.md の「型システムを最大限活用」にも直結する。
  - 提案（型で塞ぐ。tsgo で動作確認済み）:
    ```ts
    // 手順は同期でなければならない: 非同期にすると失敗が `failures` に載らず、
    // 手順 5 より前に完了することも保証できない。
    const step = <T>(run: () => T extends PromiseLike<unknown> ? never : T) => {
      try {
        run();
      } catch (error) {
        failures.push(error);
      }
    };
    ```
    実測: この形にすると `step(() => Promise.resolve())` が `error TS2322: Type 'Promise<void>' is not assignable to type 'never'.` で落ち、現在の 3 手順はそのまま通る。なお `<T extends void>(run: () => T)` は**効かない**（T が `void` に推論されて通ってしまうことを確認済み）ので、条件型が必要。
    型の見た目が気になるなら次善策として、少なくとも `// 手順は同期であること` の 1 行コメントは要る（ADR-009 の基準では劣る選択だが、現状の「何も書いていない」よりは良い）。どちらを採っても差分は数行で、**別 Issue にするほどの話ではない**。

- **[W-002]** **`src/index.ts:186-189` の「この文字列をテストが assert している」コメント 4 行は、プロダクションコードにテストの都合とテスト側の論証を持ち込んでいる。** comment-cleanup 基準では「消すべき（メタデータ）」側。**今直すべき小さな改善**（削除、または 1 行に圧縮）。
  - 場所: `src/index.ts:186-189`
    ```ts
    // `src/index.shutdown-process.test.ts` asserts on "Server stopped": it is
    // the only externally visible evidence that `shutdown()` settled (exit
    // code 0 alone does not prove it). Keep that substring if the wording
    // changes.
    ```
  - 問題 1: **2〜3 行目（「なぜこの文字列が判別性を持つのか」）は、テスト側に既にもっと詳しく書かれている**。`src/index.shutdown-process.test.ts:172-182` が 11 行かけて同じことを書いており（`outro(...)` の位置／exit code 0 では判別できない理由／実測「ハングした `shutdown()` は exit 0 / 6ms で『Server stopped』が出ない」）、プロダクション側の 2 行はその劣化コピーになっている。テストの正当化はテストに 1 箇所だけあるべきで、二重管理は片方が古くなる。
  - 問題 2: 4 行目（`Keep that substring if the wording changes.`）だけがプロダクション側にある意味を持つが、これが守ろうとしている失敗モードは**既に十分うるさい** — 文言を変えれば CI が落ち、落ちた先のテストに理由が 11 行書いてある。「静かに壊れるから注意を促す」タイプの why ではない。
  - 他の選択肢との比較:
    - **定数を共有する** — 採るべきでない。テストは `spawn` で子プロセスを起動して stdout を読む E2E であり、`src/index.ts` は import した時点で CLI が走るのでテストから直接 import できない。共有するには文字列 1 個のために新しいモジュールを作ることになり、割に合わない。
    - **テスト側にだけコメントを置く** — 既にそうなっている（`:172-182`）。プロダクション側は重複でしかない。
    - **1 行に圧縮する** — 妥協案としては可。例: `// "Server stopped" is asserted by src/index.shutdown-process.test.ts.`
  - 提案: 4 行を削除する（テスト側の 11 行で十分）。残すなら上記 1 行まで。**なお `:178-180` の `logger.info` の why コメント（`^C` エコーとの分離／再発時の切り分け）は残すべきで、そちらには手を付けないこと。**

#### Notes

- **[N-001]** **`failures: unknown[]` + `AggregateError` という型選択は妥当。裏取り済み。**
  - `unknown[]`: `catch (error)` が `unknown` を与える（`useUnknownInCatchVariables` は `strict: true` に含まれる）以上、これは**情報を落としていない**。`Result<T, E>` を使わない判断も正しい — リポジトリ内の `Result` の `E` は実際すべて `TypedError` 派生（`ReadTextFileError` / `BuildTreeError`）で、`unknown` を載せるのは慣習外。ADR-002:183 の記述と一致する。
  - `AggregateError` の型: `lib.es2021.promise.d.ts:17` に `interface AggregateError extends Error { errors: any[] }`、コンストラクタも同ファイルにある。`tsconfig.json` の `lib` は `["ES2024"]` なので**型は引ける**（`pnpm typecheck` green で裏取り）。ランタイムも実測: `node v22.22.1` で `typeof AggregateError === "function"`、`new AggregateError([1,2],'m').errors.length === 2`。`engines.node` は `>=22.0.0` で、`AggregateError` は Node 15 から。ADR-002:184 の「ECMAScript 標準（`lib: ES2024`）で追加の型定義が要らない」は正確。
  - 既存の例外処理の慣習との整合: リポジトリで例外を投げる／集約する箇所は少ないが、`src/index.ts:187` の `catch (e: unknown)` → `logger.error` という受け口はそのままで、失敗 1 件のときは包まない（`src/server/index.ts:260-261`）ので**既存の見え方が変わらない**。設計として素直。
  - 型で狭める余地があるとすれば `TimeoutOutcome<T>` の 3 分岐化だが、これは 2 ラウンドかけて検討・却下されている（ADR-002:182「`withTimeout` に『タイムアウト』と『対象の失敗』の 2 つの関心を持たせることになる」）。この却下理由は妥当で、実際 `try`/`catch` + `failures.push` で同じ分離が得られている。**蒸し返さない。**

- **[N-002]** **`step(run)` のクロージャによる `failures` 書き換えは、CLAUDE.md の「ステートレスな純粋関数型スタイル」と衝突するが、ここでは許容が妥当。** より宣言的な形（`[() => sse.shutdown(), ...].flatMap(run => { try { run(); return []; } catch (e) { return [e]; } })`）は書けるが、手順を等質なリストに畳むと ADR-002 の中心的主張である「順序に理由がある」「各手順が何のためにあるか」を表す番号付きコメントの置き場が失われる。`runShutdown()` は外部資源の破棄が本質のルーチンで、純粋にはできない。**3 ラウンド目で作り直しを求める話ではないし、別 Issue にする価値も無い。**指摘として記録するに留める。

- **[N-003]** **`if (!closed) clients.add(client)` の不変条件（`closed === true` ⇒ `client ∉ clients`）はコードとして正しい。読み直して全経路を確認した。**
  - 確立: `closed = false` / `client ∉ clients` で開始。`clients.add()` は `!closed` のときだけ。
  - 保存: `cleanup()` は `closed = true` と `clients.delete(client)` を**同一の同期ブロック**で行い（`src/server/routes/sse.ts:58-64`）、`shutdown()` は `client.close()`（= `cleanup`）を全件に対して呼んでから `clients.clear()` する（`:41-44`）。`Set` は反復中の現在要素の削除に対して安全なので、`shutdown()` のループ内 `cleanup()` による `delete` も問題ない。
  - `!closed` チェックと `add` の間に割り込みは無い（同一同期ブロック）。
  - コメント（`:75-79`）の事実主張も裏取りした: `node_modules/hono/dist/utils/stream.js` の `abort()` は `if (!this.aborted) { this.aborted = true; this.abortSubscribers.forEach(...) }` で、**latch + その時点の購読者にのみ通知**。`onAbort()` は `abortSubscribers.push()` するだけ。「登録が遅れると二度と発火しない」という主張は正確。
  - 型からは読み取れない（クロージャ 2 変数の関係なので当然）が、この規模では過剰な型付けの方が害。`SSEClient` を判別可能ユニオンにするような話は不要。

- **[N-004]** **`close()` の memo 化（`src/server/index.ts:205-213`）は、ADR-009 の再入ガード導入によって現在は到達不能になっている。** `shutdown()` は `if (shutdownPromise) return shutdownPromise;` の直後に `Promise.withResolvers()` の promise を代入してから `runShutdown()` を呼ぶので、`runShutdown()` は高々 1 回しか走らず、`close()` の呼び出し箇所も `:231` の 1 箇所のみ。`closePromise ??=` は現状 dead な防御である。害は無く（`ERR_SERVER_NOT_RUNNING` という実在の落とし穴を 2 行のコメントで記録する価値はある）、削除を求めるものではないが、**ADR-002:204 の「内部からの二重呼び出しを構造的に防ぐ」は、いま構造的に防いでいるのは ADR-009 の再入ガードの方である**という点だけ記録しておく。

- **[N-005]** **ADR-002 Consequences の `:211`「失敗が握り潰される経路が無い」は、見出しの一文だけを読むと過大である。** 続く文が「手順 2〜4 の失敗と `closing` の**予算内** reject が同時に起きても」と正しく限定しているので実質的な誤りではないが、`src/lib/with-timeout.ts:16-18` は「予算超過後（および予算ゼロ）の reject は購読するが破棄する — nothing reports it」と明記している。1 語（「予算内の失敗が握り潰される経路が無い」）足せば揃う。**文書のみの話で、コードは正しい。**

- **[N-006]** **コメント 89 行を comment-cleanup 基準（残す: ドキュメンテーション・why/why not ／ 消す: 経緯・メタデータ・自明な言い換え）で分類した結果、W-002 の 4 行を除けば残すべきものだけになっている。**
  - `src/server/index.ts`（41 行）: ドキュメンテーション 19 行（`StartServerOptions` 5 / `ServerInstance.shutdown` 9 / `SHUTDOWN_TIMEOUT_MS` 5）、why 22 行（memo 化 2 / 手順分離の前提 3 / 手順 1〜5 の理由 14 / memo 公開順 3）。**経緯・メタデータは 0 行**。R2 で指摘した `:273-275` の「この PR がやめようとしている物語」は消え、「なぜ `shutdownPromise = runShutdown()` ではだめか」という why-not だけが残った。
  - `src/server/routes/sse.ts`（25 行）: ドキュメンテーション 10 行（型側 5 / `shutdown()` 5）、why/why-not 13 行（`onAbort` 先行登録 5 / ② の到達不能性と存置理由 5 / `.catch()` を付けない理由 2 / abort が期待挙動 1）、自明な言い換え 1 行（`:95` `// Keep connection alive with comment lines`。ただし**これは `main` にもあった 2 行のうちの 1 行**で本 PR の増分ではない）。
  - `src/lib/with-timeout.ts`（23 行）: 全行がドキュメンテーションと why（配置は ADR 参照 1 行、契約 3 分岐、予算ゼロの意味論、`unref()` しない理由）。R1 で 33 行だったものが 23 行。
  - 結論: **89 行は「多い」ではなく「並行性とライフサイクルという主題に対して妥当」**。`main` の 2 行と比べるのは意味が無い（`main` は契約が何も書かれていなかった）。Phase 6 の comment-cleanup をかけて消えるべきなのは W-002 の 4 行だけで、他は残るべき。むしろこれ以上削ると ADR への外部参照だけが残って、コードだけ読む人が手順の順序を安全に変えられなくなる。

- **[N-007]** **計画で「不採用」とした 5 項目は依然として混入していない**（HEAD で再確認）。stdio drain なし（`src/index.ts` に `drain` / `stdout.write` のヒット 0）、打ち切り時の再 `closeAllConnections()` なし（`src/server/index.ts:249-258` は `logger.warn` のみ）、`closeIdleConnections()` の呼び出しゼロ（`grep -rn closeIdleConnections src/` はコメント 1 件のみ）、`broadcast()` の no-op ガードなし（`src/server/routes/sse.ts:28-32` は `main` から未変更）、`isHttpServer` なし（`grep` ヒット 0）。逆方向の実装漏れも無い。

---

## 良かった点（記録）

- **W-002 への対応が「別の根拠に差し替える」ではなく「実測して結論を『どちらでも壊れない』に確定させ、根拠をコードから撤去する」だった。** ADR-001:87 が **採用しなかった 2 つの根拠を、なぜ誤りかとセットで残している**のは、同じ提案（自分が R2 で出した「片側専用だから」を含む）が再演されるのを防ぐ最良の形。`src/core/` がそもそも共有層ではないという実測は、こちらの提案の前提を否定するもので、指摘に迎合していない点も良い。
- **エラー分離が「配列 + 1 件なら包まない」に落ち着いたことで、既存の見え方を一切変えずに失われる失敗が無くなった。** `AggregateError` は語彙としても正しく、`lib: ES2024` で追加の型定義が要らない点まで ADR に書かれている。3 つの回帰ガード（単独失敗が unwrap されること / 2 手順の集約 / 手順 5 の reject との集約）が全部あり、R2 で「回帰ガードが無い」と指摘された箇所が埋まった。
- **`src/server/index.test.ts` の `withStubbedServer(stubs, options, run)` という抽象化が、順序・分離・有界待機の 3 つを 1 つの土台で観測可能にしている。** 特に `onClose: () => {}`（コールバックを呼ばない = `closing` を永久 pending にする）で「手順 5 に到達したことしか説明のつかない経過時間」を作る設計は、この PR で一番検証が難しい主張に決定的な判別性を与えている。ヘルパの doc も「なぜスタブでないと観測できないか」に絞られていて過不足がない。
- **`plan.md` の追随が機械的でない。** `:61` の「当初『残す』判断だったが実装レビューで削除に反転した（削除基準の後半を満たすため）」のように、**結論を書き換えるだけでなく反転の事実と理由を 1 行残している**ため、plan だけを読んでも判断の履歴が追える。ADR とは粒度が違う（plan は「何をやるか」、ADR は「なぜ」）という役割分担も保たれている。
- **ADR からレビュー ID 参照が完全に消えた。** `grep -nE '\b(B|W|N)-0[0-9]{2}\b'` のヒットは 0 件。残っている「レビューで改訂」「実装レビューで撤回」は**レビュー応答ログではなく判断の改訂履歴**であり、ADR に残るべき情報。線引きが正しい。
