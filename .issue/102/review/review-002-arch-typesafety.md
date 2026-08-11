# Architecture & Type Safety Review #002

**Date:** 2026-07-25
**Round:** 2回目
**対象:** PR #116 (`issue/102/fix-shutdown-hang`, HEAD `b8e5da3`) / Issue #102
**参照:** `.issue/102/plan.md`, `.issue/102/adr.md`(ADR-001〜009), `.issue/102/review/review-001-arch-typesafety.md`, `.issue/102/review/triage.md`, `CLAUDE.md`

検証したもの: `gh pr diff 116` 全差分、`src/server/index.ts` / `src/server/routes/sse.ts` / `src/lib/with-timeout.ts` / `src/index.ts` / `src/index.shutdown-process.test.ts` / `src/server/index.test.ts` / `src/lib/with-timeout.test.ts` 全文、`tsconfig.json` / `biome.json` / `vitest.config.ts` / `tsdown.config.ts` / `package.json` / `scripts/build-client.mjs`、`node_modules/typescript/lib/lib.es2024.promise.d.ts`、`src/core/result.ts` / `src/core/error.ts`、生成済み `src/server/renderer/client-bundle.js`。
実行したもの: `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`（**27 files / 268 tests all pass**、いずれも green）、隔離 worktree でのフォールト注入 1 件（W-001 の実証。実施後に `git worktree remove` 済み）。

---

## Summary

- Blockers: 0
- Warnings: 6
- Notes: 8
- Verdict: **APPROVED**

**全体評価**: 1 ラウンド目の Blocker 1 件・Warning 8 件は、意図的な wont-fix 1 件を除きすべて解消されている。特に B-001（`isHttpServer`）の撤回、W-003（`shutdown(options)` → `startServer(config, options)`）、W-004（`watcher` 削除）は、指摘の趣旨どおりに直っただけでなく **ADR に撤回理由が残されている**。新規の ADR-008 / ADR-009 も判断として妥当で、`Promise.withResolvers()` は Node / TS の前提を実際に満たしていることを確認した（N-002）。

今回の指摘はすべて「コードが壊れている」系ではなく、**契約記述の正確さ（W-001 / W-002 / W-003）** と **設計文書のメンテナンス（W-005 / W-006）**、**コメント総量（W-004）** に集中している。W-002 は 1 ラウンド目の指摘に対する修正が「割れた基準」を「誤った基準」に置き換えてしまった部分的後退なので、優先して直してほしい。

---

## 1ラウンド目指摘の解消状況

- **[B-001]** `isHttpServer` 型述語 → **解消**。`src/server/index.ts:237` は `if ("closeAllConnections" in server)` に戻り、`node:http` / `@hono/node-server` の型 import も消えた。ADR-004 は Status に「1 周目の Decision を撤回した ADR」と明記し、撤回理由（コンパイラ未検証のアサーション／利点 (2) は ADR-007 の撤回で消滅）を残している。
- **[W-001]** `withTimeout` doc の「reject 透過」 → **解消**。`src/lib/with-timeout.ts:18-20` が「Rejects only when `promise` rejects *inside* the budget. A rejection after the budget elapsed (or under a zero budget) is subscribed to so that it is never unhandled, but it is discarded — nothing reports it.」に書き換わり、実装（`:36` の `promise.catch(() => {})` / `:52` の settle 済み promise への `reject`）と一致する。**ただし型で 3 分岐にする案は採らなかったため、その帰結が W-001（本ラウンド）として再浮上している。**
- **[W-002]** `src/lib/` 配置根拠の不整合 → **部分的**。「副作用の有無」という後付け基準は撤回され、ADR-001:85-92 が根拠を差し替えて逆命題の不成立まで自ら断っている点は良い。しかし差し替え先の根拠（クライアントバンドル）自体が事実として誤っている（本ラウンド W-002）。
- **[W-003]** `shutdown(options)` のテスト注入 API → **解消**。`startServer(config, options?: StartServerOptions)` に移り（`src/server/index.ts:43-49, 153-157`）、`ServerInstance.shutdown` は `() => Promise<void>` に戻った。ADR-008 が新規に立てられ、選択肢 a〜d と却下理由が記録されている。残る doc の穴は本ラウンド W-003。
- **[W-004]** `watcher` の削除基準の一貫性 → **解消**。`ServerInstance` は `{ shutdown }` の 1 メソッド型（`src/server/index.ts:51-62`）。ADR-005:313 が「基準の後半を過小に読んでいた」と改訂理由を明示。`setupWatcher()` の戻り値の扱いは変わっていない（N-004）。
- **[W-005]** `SseManager.shutdown` の doc 参照先 → **解消**。`src/server/routes/sse.ts:13-17` が型側に 3 行で書き切り、`ServerInstance.shutdown` との粒度差（「SSE サブシステムのみ」「その 1 ステップとして呼ばれる」）と 3 つの事後条件（503 / `broadcast()` no-op / 再開不可）を明示している。dangling な `see createSseManager()` は消えた。
- **[W-006]** `with-timeout.ts` の doc 過剰 → **解消（当該ファイルについては）**。コメント行 33 → 25（実測）。テスト戦略の正当化は 1 節に圧縮、マイクロタスクの一般論は削除、unref は 3 行 + ADR 参照。ただし PR 全体ではコメントが増えている（本ラウンド W-004）。
- **[W-007]** `logger.info` の正常系混入 → **未解消（意図的 / wont-fix）**。`src/index.ts:182` に残存。triage で「真因未特定の本 Issue ではハンドラ起動の事後判別が唯一の手掛かり」「実 TTY で `^C` エコーとの分離を検証済み」として wont-fix。前提を踏まえれば納得できるので蒸し返さない（N-007）。
- **[W-008]** テストの配置 → **解消**。`src/server/shutdown-process.test.ts` → `src/index.shutdown-process.test.ts` に移動。既存の aspect-suffix 前例（`src/lib/watcher.error-handling.test.ts`）と整合し、冒頭 4 行に配置理由も書かれている（N-005）。
- **[N-008]（1 ラウンド目の未コミット変更）** → **解消**。`git status` は clean、`src/server/index.ts` に `await new Promise((r) => setTimeout(r, 0))` は存在しない。
- **[N-007]（`waitForServer` と `testTimeout` の競合）** → **未対応**（Note のため triage 未掲載）。本ラウンド N-008 として再掲。

---

### Architecture & Type Safety

#### Blockers

- なし。

#### Warnings

- **[W-001]** エラー分離の型設計に**失敗チャネルが 1 本しかなく**、手順 2〜4 のエラーが `closing` の reject に上書きされて無言で消える経路がある。ADR-002 の「エラーは握り潰されず…CLI の `logger.error` に届く」は無条件には成立しない。
  - 場所: `src/server/index.ts:224`（`let failure: { readonly error: unknown } | undefined`）/ `:245`（`const outcome = await withTimeout(closing, shutdownTimeoutMs)`）/ `:251-253`（`if (failure) throw failure.error`）/ `.issue/102/adr.md:140, 168`
  - 実証（隔離 worktree でフォールト注入、実施後に撤去）: 手順 3 の直後に `throw new Error("STEP3-FAILED")` を注入し、同時に `close()` を 5ms 後に `CLOSE-FAILED` で reject させたところ、`shutdown()` が reject した値は **`CLOSE-FAILED`** だった。`await withTimeout(...)` が throw した時点で `if (failure) throw failure.error` に到達しないため、捕捉済みの `STEP3-FAILED` は**どこにも記録されずに破棄される**。
  - 理由: `{ error: unknown } | undefined` という箱は「手順 2〜4 の失敗を保持する」という一点は正しく解いている（`undefined` を throw された場合の取り違えも防げている）が、**関数の出口が `throw` 1 本しかない**という構造を変えていないため、独立した 2 つの失敗が 1 つのスロットを奪い合う。到達可能性は実質ゼロに近い（`close()` は memo 化されており `ERR_SERVER_NOT_RUNNING` は構造的に起きない）ので Blocker にはしないが、ADR がこの保証を無条件で謳っている以上、記述か実装のどちらかを合わせるべきである。
  - なお 1 ラウンド目 W-001 で提案した「`TimeoutOutcome<T>` に `{ status: "failed"; error: unknown }` を足して 3 分岐にする」案は、**(a) 予算超過後の reject が無言で消える問題と (b) 本件の衝突を同時に解いていた**。doc で (a) を説明する道を選んだ結果、(b) が残っている。
  - 提案（いずれか）:
    1. `TimeoutOutcome<T>` を 3 分岐にし、`close` の失敗も `logger.error` で必ず記録したうえで `failure` を rethrow する（型で最も素直。CLAUDE.md の「型システムを最大限活用」にも沿う）。
    2. 出口だけ直す: `await withTimeout(...).catch((e: unknown) => { closeError = e; return { status: "timed-out" } as const; })` として、最後に `failure` と `closeError` の両方が立っていれば `AggregateError` を throw する。
    3. 実装を変えないなら、ADR-002:168 を「手順 2〜4 の失敗は、`close()` 自身が予算内に reject しない限り呼び出し側に届く」に限定して書き換える。

- **[W-002]** `src/lib/` 配置の根拠が「割れた基準」から「**事実として誤った基準**」に置き換わった。1 ラウンド目 W-002 に対する部分的な後退。
  - 場所: `src/lib/with-timeout.ts:1-7`（module doc）/ `.issue/102/adr.md:85-92`（ADR-001）/ `.issue/102/review/triage.md`（「`src/core/` はクライアントバンドル対象で、サーバー専用モジュールを置くと不要にバンドルが太る」）
  - 主張されている根拠: 「`src/core/` is imported from `src/client/**` and therefore ends up in the client bundle; this helper is only ever used by the server.」/ ADR-001:87「サーバー専用のユーティリティを置くと、使われないコードでバンドルが太る。」
  - 反証（実測）: クライアントバンドルは `scripts/build-client.mjs` が **`entryPoints: ["src/client/entry.tsx"]` + `bundle: true`** で esbuild ビルドしたものである。したがって**バンドルに入るのはエントリから import 到達可能なモジュールだけ**で、ディレクトリ所属は無関係。生成済みの `src/server/renderer/client-bundle.js`（32,558 バイト）を実際に検査したところ、`src/core/` にありながらクライアントから import されていない次のモジュールは**1 つも含まれていなかった**:

    | 検出したい文字列 | 由来 | バンドル内 |
    |---|---|---|
    | `node:path` | `src/core/path.ts` | false |
    | `flatMap` / `mapError` / `getOr` | `src/core/result.ts` | false |
    | `typedError` | `src/core/error.ts` | false |

    （`src/core/path.ts` が丸ごと載るなら `node:path` の解決に失敗してブラウザ用バンドルが壊れるはずで、ビルドが通っている時点でも同じ結論になる。）
  - つまり `withTimeout` を `src/core/` に置いても**バンドルは 1 バイトも太らない**。ADR-001:90 は「`src/lib/` = サーバー専用という逆命題は成り立たない」と自ら断っているが（これは正しい — `src/client/lib/sse.ts:7` が `src/lib/logger.js` を import しており、`src/lib/` も現にバンドルに載っている）、順命題（`src/core/` に置くとバンドルに載る）も成り立たない以上、この根拠は**どちら向きにも何も支えていない**。
  - 影響: 配置そのもの（`src/lib/`）は妥当なので実害はゼロ。ただしこの誤った基準が**恒久的なコードコメントとして残る**ため、将来のコントリビュータが「`src/core/` に置くとバンドルが太る」と信じて配置判断を誤る。1 ラウンド目に「基準の書き換えを明示せよ」と言った意図は、**正しい基準に統一すること**であって、別の誤りに置き換えることではなかった。
  - 提案: バンドル論拠を捨て、事実だけで書けば足りる。例: 「`withTimeout` の利用者はサーバー層（`src/server/index.ts` の `shutdown()`）1 箇所のみ。`src/core/` は client / server 双方から共有される層なので、片側専用のユーティリティは `src/lib/` に置く」。これなら `.issue/89/adr.md` ADR-001 の「ランタイム非依存」基準とも衝突せず（共有性という別軸の話になる）、事実としても正しい。

- **[W-003]** `StartServerOptions.shutdownTimeoutMs` の doc が公開 API の契約として不完全。ADR-008 で注入点を移した結果、**驚く契約とその説明が別ファイルに分離した**。
  - 場所: `src/server/index.ts:43-49`（doc）/ `src/lib/with-timeout.ts:22-24`（説明の実体）/ `src/server/index.test.ts:125`（唯一の実利用が `{ shutdownTimeoutMs: 0 }`）
  - 理由:
    - (a) **`0` / 負数 / `NaN` が「即座に諦めて警告を出す」を意味することが、この型の doc に一切書かれていない。** 「Upper bound for waiting on `server.close()` inside `shutdown()`.」だけを読んだ利用者が `0` を「上限なし＝無制限に待つ」と解釈するのは十分ありうる誤読で、実際の挙動は正反対（`!(timeoutMs > 0)` で即 `timed-out` + `logger.warn`）。この意味論は `withTimeout` の doc にしか書かれていないが、`withTimeout` は非公開の内部ヘルパであり、`StartServerOptions` だけが公開面である。しかも**リポジトリ内で唯一この値を明示的に渡しているコードがまさに `0` を渡している**。
    - (b) 「Defaults to `SHUTDOWN_TIMEOUT_MS`」が **非 export の module private const**（`src/server/index.ts:70`）を指しており、型を見る側から既定値（2,000ms）が読めない。
    - `shutdownTimeoutMs?: number` を型で狭める手段は（`number` の subtype がない以上）実質ないため、ここは doc で補うしかない箇所である。
  - 提案: 2 行足すだけで解ける。
    ```ts
    /**
     * Upper bound (ms) for waiting on `server.close()` inside `shutdown()`.
     * Defaults to 2,000ms. A non-positive value (or `NaN`) means "give up
     * immediately and warn" — it is not "wait forever".
     */
    readonly shutdownTimeoutMs?: number;
    ```

- **[W-004]** **コメント総量が 1 ラウンド目より増えている。** 指摘した `with-timeout.ts` は縮んだが、他 2 ファイルの増分がそれを上回った。Phase 6 の comment-cleanup 方針に照らすと、「修正の経緯」「レビューでの議論」がコードに残っている箇所が複数ある。
  - 実測（コメント行数 / `grep -cE '^\s*(//|/\*|\*)'`）:

    | ファイル | `origin/main` | R1 (`3693d5d`) | R2 (`b8e5da3`) |
    |---|---|---|---|
    | `src/server/index.ts` | 0 | 29 | **45** |
    | `src/server/routes/sse.ts` | 2 | 18 | **28** |
    | `src/lib/with-timeout.ts` | (新規) | 33 | 25 |
    | 計 | 2 | 80 | **98** |

  - 特に圧縮すべき箇所:
    - `src/server/index.ts:261-265` — **コメント 5 行に対しコード 4 行**。「`shutdownPromise = runShutdown()` would only be assigned once `runShutdown()` reached its first `await` … — exactly the kind of "safe because it happens to be synchronous" that **this shutdown path is meant to stop relying on**.」後半は ADR-009 の要約であると同時に、**この PR 自身が何をやめようとしているかという物語**をコードに残している。将来の読者にとって必要なのは「代入を `runShutdown()` の呼び出しより前に完了させるため」という 1 行だけ。
    - `src/server/routes/sse.ts:81-94` — **コメント 10 行に対しコード 4 行**。うち「Taking this branch yields HTTP 200 + text/event-stream + an immediate EOF rather than the 503 of ①: `streamSSE` fixes status and headers itself, so all that is left to do here is end the stream.」の 3 行は ADR-003:214 の内容そのままで、コードを読む上では不要。「Unreachable today ... e.g. if Hono's dispatch becomes asynchronous」は why-not として残す価値があるが、2 行で足りる。
  - 提案: `with-timeout.ts` で実際に採った処方（契約 + why を最小限 + `.issue/102/adr.md` ADR-00N への参照 1 行）を、この 2 箇所にも同じように適用する。並行性が主題のコードなので `src/server/index.ts` の手順 1〜5 の番号付きコメントと各手順の 1 行 why（`:215-219`, `:226`, `:228`, `:230-236`, `:243-244`）は**残すべき**で、削るのは上の 2 ブロックに限ってよい。

- **[W-005]** **ADR 内部に改訂前の手順番号が 4 箇所残っている。** 本 PR の中心的主張（手順順序）についての記述なので、将来の読者が逆の順序を信じうる。
  - 場所: `.issue/102/adr.md`
    - `:169`（ADR-002 Consequences）「リスニングハンドルは**手順 2** で閉じるため、タイムアウトで打ち切ってもポートは解放済みである」
    - `:212`（ADR-003）「`server.close()` をシャットダウン冒頭（ADR-002 の**手順 2**）で呼ぶため」
    - `:454`（ADR-007）「ADR-002 の**手順 2** でリスニングハンドルを閉じているため手順 4 以降に新規ソケットが accept されることはなく」
    - `:458`（ADR-007）「ポート自体はリスニングハンドルを閉じた時点（ADR-002 の**手順 2**）で解放される」
  - 理由: 改訂後の ADR-002:124 と実装（`src/server/index.ts:220`）はいずれも `close()` が**手順 1**。同一文書内で同じ操作の番号が 1 と 2 に割れており、特に `:454` は「なぜ再 `closeAllConnections()` が不要か」という**撤回判断の根拠**が古い番号に依存して書かれている。
  - 提案: 4 箇所を「手順 1」に直す。ADR-002 を改訂するときに他 ADR からの参照を追わなかったのが原因なので、`grep -n "手順 [0-9]" .issue/102/adr.md` を改訂時のチェックに加えるとよい。

- **[W-006]** **`.issue/102/plan.md` が 2 ラウンド目でまったく更新されておらず（`git show --stat b8e5da3` に含まれない）、実装および改訂後の ADR と矛盾している。** PR 本文が「実装計画」として指しているのはこの文書である。
  - 矛盾箇所（実測）:
    - `:58` `:115` `:517` `:542` — 「`in` ナローイングを型述語 `isHttpServer` に置換する / 型述語で意図を明示すべき」→ **ADR-004 で撤回済み。実装は `in` のまま。**
    - `:297` `:516` — 「`watcher` は残す（ADR-005 の削除基準は…`watcher` は後半を満たさない）」→ **ADR-005 で判断が反転し、実装からは削除済み。**
    - `:543` — ADR-005 の要約が `close` / `sseCloseAll` のみで `watcher` を含まない。
    - `:539-545` の ADR 一覧 — **ADR-008 / ADR-009 が存在しない**（`grep "ADR-00" .issue/102/plan.md` に一切ヒットしない）。今回の 2 大設計変更（オプションの置き場・再入ガード）が計画側から辿れない。
    - `:66` — 「手順 2 でリスニングハンドルを閉じているため」（W-005 と同じ古い番号）。
    - `:182` — 「`Result<T, E>` は使わない — `TypedError` は `cause: Error` を必須とするが」。1 ラウンド目 N-001 で「それは `Result` の制約ではない（`Result<void, "timed-out">` と書ける）」と指摘した箇所が未修正（Note だったため triage 未掲載。結論自体は妥当なので根拠だけの問題）。
  - 理由: ADR だけ 241 行改訂して plan を据え置いたため、**2 つの設計文書が互いに矛盾する状態**になっている。ADR は「なぜ」の記録、plan は「何をどの順でやるか」の記録という役割分担がある以上、実装が計画から外れたなら plan 側にも反映（または「ADR-00N で変更」という 1 行）が要る。
  - 提案: 全面改訂までは不要。該当箇所に「→ ADR-004 で撤回」「→ ADR-005 で削除に変更」の 1 行を足し、`:539-545` の ADR 一覧に ADR-008 / ADR-009 を追加する。

#### Notes

- **[N-001]** ADR-004 は撤回の記録として機能しているが、**正味の差分が「コメント 3 行」の判断に 44 行**（`:243-294`）を割いている。ADR 自身が「撤回の結果、この ADR が生む差分は『なぜナローイングが必要かを説明するコメント 3 行』だけになった」と書いており、自己認識はある。却下した代替案（`as` アサーション / `createAdaptorServer`）の記録には価値があるので削除は求めないが、粒度としては ADR-002 の一節に畳んでも情報は失われない。「ADR にすべきでない実装詳細が混ざっていないか」という観点で、9 本中もっとも境界線上にある。

- **[N-002]** **`Promise.withResolvers()` の前提はすべて満たされている**（ADR-009:577 の主張を実際に裏取りした）。
  - ランタイム: 実行環境の `node -e "console.log(process.version, typeof Promise.withResolvers)"` → `v22.22.1 function`。`package.json` の `engines.node` は `>=22.0.0` で、この API は Node 22.0.0 から利用可能。
  - 型: `tsconfig.json` の `target` / `lib` はいずれも `ES2024`、`node_modules/typescript/lib/lib.es2024.promise.d.ts:32` に `withResolvers<T>(): PromiseWithResolvers<T>` があり型が引ける。`pnpm typecheck`（tsgo）green。
  - 既存スタイルとの整合: リポジトリ内で `Promise.withResolvers` の使用は本 PR が初だが、`new Promise<void>((resolve, reject) => ...)` は `src/server/index.ts:190, 209` 等に既にある。deferred が必要な唯一の理由（memo 代入を本体実行より前に完了させる）は他の書き方では満たせないので、初出であること自体は問題にならない。
  - `runShutdown().then(resolve, reject)` はフローティングだが、`resolve` / `reject` は throw しないため unhandled rejection にはならない。`pnpm lint`（biome）も green。
  - ADR-009 が b 案（`Promise.resolve().then(run)`）を「AC-4 を壊すので不可」として却下した理由づけも正しい。`src/server/index.test.ts` の "shutdown step order" が `instance.shutdown()` の**直後に同期的に** `calls` を読んで `["close", "closeAllConnections"]` を期待しており、b 案ならここが空配列になる。

- **[N-003]** **エラー分離に `Result<T, E>`（`src/core/result.ts`）を使うべきではなかった、という判断は正しい。** `Result` は「関数の返り値として成否を表す」語彙であり、ここで表現したいのは「後で throw するために保留した例外」なのでレイヤが違う。加えてリポジトリ内の `Result` の `E` は実際すべて `TypedError` 派生（`ReadTextFileError` / `BuildTreeError`）で、`unknown` を載せるのは慣習外である。`{ readonly error: unknown } | undefined` というローカルな箱は、`undefined` を throw された場合の取り違えを防ぐ点も含めて素直。より良い型表現があるとすれば `Result` ではなく `TimeoutOutcome` 側の 3 分岐化（W-001）である。

- **[N-004]** **`ServerInstance` が 1 メソッド型になったことには意味がある。** 構造型として `{ shutdown: () => Promise<void> }` と等価だが、(a) `startServer` の返り値に名前を与える、(b) 契約（冪等・有界・ソケットが残りうる・プロセス終了は呼び出し側の責務）を JSDoc で運ぶ、という 2 つの役割があり、エイリアスとしての価値は失われていない。`watcher` 削除による `setupWatcher()` の戻り値の扱いの変化も**ない** — `src/server/index.ts:182` の `watcher` は listen エラー経路（`:198`）と手順 3（`:229`）の両方でクロージャから使われており、`noUnusedLocals: true` の下で `pnpm typecheck` が通ることでも裏付けられる。ADR-005:334 の「内部には影響しない」という注記は正確。

- **[N-005]** **`src/index.shutdown-process.test.ts` の命名・配置と `src/__test_shutdown_fixture__` は、いずれも既存規約と整合している。実際に確認した。**
  - 命名: aspect-suffix の前例は `src/lib/watcher.error-handling.test.ts`（`{module}.{aspect}.test.ts`）。`index.shutdown-process.test.ts` は同型。被験体（`src/index.ts`）と同居しており、リポジトリの「テストは対象と同じ場所」規約にも合う。冒頭 4 行に配置理由も書かれている。
  - fixture: `import.meta.dirname` 直下に `__test_*__` を作って `afterAll` で消すのは既存 7 例と同じパターン（`src/server/__test_server_fixture__` / `src/lib/__test_fixture_watcher__` / `src/lib/__test_cache_fixture__` / `src/lib/__test_fixture__` / `src/server/routes/__test_fixture_dir__` / `__test_fixture_api__` / `src/lib/__test_gitignore__` ほか）。**`testdata/` を使わないのは正しい** — `testdata/` は Markdown レンダリングのサンプルを**コミット済み**で置く場所であり、テストが作って消すスクラッチ領域ではない（`biome.json` も `!testdata/**/*.html` として別扱いしている）。
  - 副作用: `tsconfig.json` の `include: ["src/**/*"]` に入るが中身は `README.md` のみで tsgo の対象にならない。`tsdown.config.ts` の entry は `src/index.ts` のみ。`vitest.config.ts` の `exclude` は `node_modules` / `.direnv` のみで影響なし。`biome.json` は `**` を見るがディレクトリはテスト実行中しか存在せず、既存 fixture と条件は同じ。`pnpm typecheck` / `lint` / `format:check` / `test` すべて green を実測。

- **[N-006]** **計画で「不採用」とした 4 項目は依然として混入していない**（コードで確認）。stdio drain なし（`src/index.ts:189-190` は `outro()` → `process.exit(0)` で `await` の追加なし）、打ち切り時の再 `closeAllConnections()` なし（`src/server/index.ts:246-250` は `logger.warn` のみ）、`closeIdleConnections()` の呼び出しゼロ（`grep` でヒットなし）、`broadcast()` の `shuttingDown` ガードなし（`src/server/routes/sse.ts:28-32` は未変更で、契約は `shutdown` の doc `:16` に記載）。逆方向の実装漏れも見つからなかった。

- **[N-007]** `logger.info`（`src/index.ts:182`）は triage で wont-fix。真因未特定という本 Issue の前提と、実 TTY での `^C` エコー分離を検証済みという根拠があり、判断として妥当。蒸し返さない。ADR-007:(3) が「真因が判明したら削除を検討する」と出口を書いている点も含めて問題なし。

- **[N-008]** **1 ラウンド目 N-007 は未対応。** `src/index.shutdown-process.test.ts:114` の `waitForServer(..., 20_000, ...)` + `:123` の `killTimer` 10,000ms = 最大 30 秒で、`vitest.config.ts` の `testTimeout: 30000` とほぼ同値。`it()` に個別 timeout は指定されていない。遅い環境では**自前の診断メッセージ（`Output:\n${output}` 付き）や `SIGKILL` に到達する前に vitest がテストを落とし、spawn した子プロセスが残留する**。今回 `waitForServer` に「子プロセスが死んだら即 bail」（`:51-55`）が入って最悪ケースの確率は下がったが、上限そのものは変わっていない。`waitForServer` を 10 秒に縮めるか `it(..., { timeout: 60_000 })` を推奨。テスト観点のレビュアーと重複する可能性がある。

---

## 良かった点（記録）

- **B-001 / W-003 / W-004 の直し方が、いずれも「指摘に合わせて表面を変える」ではなく「判断をやり直して ADR に撤回として残す」形になっている。** 特に ADR-004（型述語の撤回）と ADR-005:313（`watcher` の判断反転）は、以前の判断・なぜ間違っていたか・新しい判断の 3 点セットで書かれており、将来同じ提案が出たときに議論を再演しないで済む。
- **ADR-008 の選択肢 c（`ServerConfig` にフィールドを足す）の却下理由が的確。** 「`ServerConfig` は 3 分岐の判別可能ユニオンなので全分岐に同じフィールドを足すことになる」は実際にそのとおりで（`src/server/index.ts:19-41`）、config（何を配信するか）と options（どう運用するか）の分離という軸も自然。第 2 引数が正解だった。
- **`shutdown()` の再入ガードが `Promise.withResolvers()` になったことで、「同期実行だから安全」という依存が `shutdown()` 本体からも消えた。** この PR の主題（偶然から構造へ）を実装自身に適用しており、一貫している。ADR-009 が c 案（`let started`）を「再入した呼び出しに返す promise が無い」で却下しているのも正確。
- **`src/server/index.test.ts` の "shutdown step order" が `vi.doMock("@hono/node-server")` でスタブを差し込み、`shutting.catch(() => {})` → **await する前に** `expect(calls).toEqual(["close", "closeAllConnections"])` を評価している設計。** 手順 1〜4 が全部同期である以上、実ソケット越しの黒箱観測では順序を判別できないという制約を正しく認識したうえで、唯一判別できる方法を採っている。ADR-002 の中心的主張に初めて回帰ガードが付いた。
- **`SseManager.shutdown` の型側 doc（`src/server/routes/sse.ts:13-17`）が、同名の `ServerInstance.shutdown` との粒度差を 1 文で言い切っている。** 「unlike `ServerInstance.shutdown()` which stops the whole server and calls this as one of its steps」は、まさに型定義側にあるべき情報。
- **`in` ナローイングに戻したことで、`node:http` / `@hono/node-server` からの型 import が 2 本消え、`shutdown()` から関数 1 つ分の間接も消えた。** 「型安全性を上げる整理」のつもりの変更をやめたら差分も小さくなった、という結末は素直。
