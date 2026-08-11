# Architecture & Type Safety Review #001

**Date:** 2026-07-25
**Round:** 1回目
**対象:** PR #116 (`issue/102/fix-shutdown-hang`) / Issue #102
**参照:** `.issue/102/plan.md`, `.issue/102/adr.md`, `.issue/89/adr.md`(ブランチ `docs/issue-89-records`), `CLAUDE.md`

検証環境で実際に読んだもの: `node_modules/@hono/node-server/dist/types.d.ts`、`node_modules/@types/node@25.9.1` の `http.d.ts` / `http2.d.ts` / `process.d.ts`、`node_modules/hono/dist/utils/stream.js`、`src/core/*` / `src/lib/*` の全非テストファイル、`origin/main` の変更前 `src/server/index.ts`。

---

## Summary

- Blockers: 1
- Warnings: 8
- Notes: 8
- Verdict: **BLOCKED**

**全体評価**: 設計の骨格（有界シャットダウンを要件充足の主、構造的レース封じを従に置く二層構成）は妥当で、ADR の記述量・実測の裏取りともに水準が高い。順序変更（`server.close()` を破棄より先）、`sse.shutdown()` の終端化、二重チェック、`node:timers/promises` への置換はいずれも正しく実装されており、**計画で「不採用」とされた 4 項目（stdio drain / 打ち切り時の再 `closeAllConnections()` / `closeIdleConnections()` の併用 / `broadcast()` の no-op ガード）はコードに一切混入していない**ことを確認した。実装漏れも見つからなかった。

指摘は「実装が壊れている」系ではなく、**型安全性の主張と実際の型検査の向き**、**API 拡張の契約整合**、**ADR の根拠の正確さ**に集中している。B-001 はコード自体が壊れているわけではないが、ADR-004 として記録され将来の変更が引用する（本 PR 自身が `.issue/89/adr.md` を引用しているように）ため、根拠のまま残すコストが高いと判断した。

---

### Architecture & Type Safety

#### Blockers

- **[B-001]** `isHttpServer` は **TypeScript が検証しない型アサーション**であり、置き換え前の `in` ナローイングより型安全性が**下がっている**。ADR-004 の主張（CLAUDE.md の型安全性原則に沿う）は、この軸では逆向きである。
  - 場所: `src/server/index.ts:68-75`（ADR-004 / plan.md ステップ 8）
  - 理由:
    - 変更前 `if ("closeAllConnections" in server) { server.closeAllConnections(); }` は、TS の制御フロー解析による**コンパイラ検証済みのナローイング**である。`ServerType = Server | Http2Server | Http2SecureServer` のうち `Http2Server` / `Http2SecureServer` は `@types/node@25.9.1` では `net.Server` / `tls.Server` を継承した interface で `closeAllConnections` を持たない（`http2.d.ts:1306`, `1395`。`closeAllConnections` の宣言は `http.d.ts:463` のみ）。したがって `in` は union を `Server` に正しく絞り込み、**アサーションはコード上のどこにも存在しなかった**。
    - 変更後の `function isHttpServer(server: ServerType): server is HttpServer` は、TS が本体と述語の整合を検証しない。`return true;` に書き換えてもコンパイルは通り、`server.closeAllConnections()` は実行時に落ちる。つまり**検証済みナローイングを未検証アサーションに置き換えた**ことになる。「unsound な型述語ではないか」の答えは **yes（TS の意味で unsound な構文である）** — 現在の本体はたまたま正しいが、正しさを保証しているのは型システムではなくレビュアーの目である。
    - ADR-004 が挙げる 3 つの利点のうち、**(2)「2 箇所目の利用でも再チェックの記述が要らない」は同一 PR の ADR-007 で「打ち切り時の再 `closeAllConnections()`」が撤回されたことにより消滅している**。実際 `isHttpServer` の呼び出し箇所は `src/server/index.ts:234` の 1 箇所のみ。(1)「doc コメントの集約」は `in` の直上にコメントを置けば同じく達成できる。残るのは (3)「意図が読める」だけで、それと引き換えに型検査を 1 段落としている。
  - 提案（いずれか）:
    1. **型述語をやめ、コンパイラ検証される形にする**（推奨）。返り値の型注釈または推論で narrowing が検査されるため、本体を偽装できない。
       ```ts
       function asHttpServer(server: ServerType): HttpServer | undefined {
         return "closeAllConnections" in server ? server : undefined;
       }
       // 呼び出し側
       asHttpServer(server)?.closeAllConnections();
       ```
    2. または `in` に戻し、doc コメントだけを直上に置く（差分最小・型検査は最強）。
    3. どうしても型述語を残すなら、ADR-004 の Decision と Consequences を「型安全性の向上」ではなく「**可読性のために型検査を 1 段落とすトレードオフ**」と正直に書き換え、(2) の根拠が ADR-007 により無効化されたことを追記する。

#### Warnings

- **[W-001]** `withTimeout` の doc が「`promise` の reject は透過する」と無条件に書いているが、**タイムアウト後および予算ゼロ経路では reject が無言で握り潰される**。`TimeoutOutcome<T>` にこの第 3 の帰結が表現されていない。
  - 場所: `src/lib/with-timeout.ts:18-19`（doc）/ `:42-46`（予算ゼロ）/ `:58-61`（タイムアウト後の `reject` は既に settle 済みの Promise に対する no-op）
  - 理由: ADR-001 は「元 Promise の reject は透過させ、`server.close()` のエラーが CLI の `logger.error` に届く既存挙動を維持する」と明記している。変更前は `await close()` が**常に**エラーを伝播した。変更後は (a) 予算内に reject した場合のみ伝播し、(b) 予算超過後の reject は `promise.catch(() => {})` / 既に resolve 済みの outer promise によって**どこにもログを残さず消える**。「既存挙動を維持する」は部分的にしか成立していない。実際の到達可能性は低い（`close()` の memo 化により `ERR_SERVER_NOT_RUNNING` は起きない）が、本 PR の主題が「シャットダウン失敗の観測性」である以上、無言で消える経路を doc が「透過する」と言い切っているのは危うい。
  - 提案: doc の該当箇所を「**予算内に**reject した場合のみ透過する。予算超過後の reject は（unhandled にしないために購読はするが）破棄される」と正確に書き換える。より型で表現するなら `TimeoutOutcome<T>` に `{ status: "failed"; error: unknown }` を足して 3 分岐にし、`shutdown()` 側で `logger.error` を出す（CLAUDE.md の「型システムを最大限活用」により整合する）。

- **[W-002]** `src/lib/` 配置の根拠が **plan.md 内部で 2 つに割れており**、`.issue/89/adr.md` が定めた基準では `withTimeout` は `src/core/` 側に落ちる。コードの module doc はその再定義を既成事実として書いている。
  - 場所: `src/lib/with-timeout.ts:1-7` / `.issue/102/plan.md`「あるべきアーキテクチャ」節 vs 「ライフサイクル管理」節 / `.issue/102/adr.md` ADR-001
  - 理由:
    - plan.md「あるべきアーキテクチャ」は `src/lib/` を「**ランタイム（Node）依存**のユーティリティ」と定義し、その出典として `.issue/89/adr.md` ADR-001 を挙げている。実際の `.issue/89/adr.md` ADR-001 の文言は「ユーティリティは Node 依存のため `src/lib/project-id.ts` に置く（`src/core/` は**フレームワーク/ランタイム非依存層**のため不適）」で、基準は一貫して「ランタイム依存性」である。
    - 一方 plan.md「ライフサイクル管理」節と ADR-001 と実装の module doc は、基準を「**副作用の有無**」に置き換えている。
    - `withTimeout` は **import 文がゼロ**で、`setTimeout` / `clearTimeout` / `Promise` しか使わない。Node にもブラウザにも存在する。つまり ADR-89 の基準（ランタイム依存性）では `src/core/` 適格である。実際 `src/core/path.ts` は `node:path` を import しており（＝唯一の Node 依存）、`withTimeout` より依存が重い。
    - ADR-001 が「`src/core/` はクライアントバンドルに入りうる層だから」を誤りとして退けた根拠（`src/lib/logger.ts` が `src/client/lib/sse.ts:7` から import されている）は**事実として正しい**ことを確認した。ここは問題ない。
  - 提案: 配置自体は害が無い（実害ゼロ）ので `src/lib/` のままでよいが、**基準の書き換えを明示する**こと。plan.md の「あるべきアーキテクチャ」節と ADR-001 の文言を揃え、「`.issue/89/adr.md` ADR-001 の『ランタイム非依存』を、実態に合わせて『副作用の有無』へ精緻化する（`withTimeout` はランタイム非依存だが副作用を持つ最初のケース）」と 1 行で宣言する。コードの module doc も「`src/core/` is reserved for pure logic」と断定するのではなく、ADR への参照に留めるのが安全（`src/lib/node-error.ts` や `src/lib/markdown.ts` は副作用を持たないので、「lib = 副作用」も分割としては成立していない）。

- **[W-003]** `shutdown(options?: { timeoutMs?: number })` は**テスト注入専用にプロダクション API を広げた**もので、memo 化と契約が正面から矛盾している。矛盾を doc コメントで謝るしかない形になっているが、**型で矛盾しない設計にできる**。
  - 場所: `src/server/index.ts:47-58`（型と doc）/ `:221-223`（実装）
  - 理由: 「`shutdown()` は冪等で最初の呼び出しが勝つ」と「`shutdown()` は毎回 `timeoutMs` を受け取る」は同居できない。ADR-005 自身が「直感に反する挙動が生まれる。doc コメントで明記して緩和する」と認めている。緩和は緩和であって解消ではなく、`shutdown({ timeoutMs: 5000 })` を 2 回目に書いた読者は必ず間違える。またこの引数の唯一の実利用は `src/server/index.test.ts` の `shutdown({ timeoutMs: 0 })` であり、プロダクション経路（`src/index.ts:186`）は常に既定値を使う。
  - 提案: 予算を**インスタンス生成時**の関心事に移す。`startServer(config, options?: { readonly shutdownTimeoutMs?: number })` とし、`shutdown` は `() => Promise<void>` のまま保つ。こうすると (a) memo 化との矛盾が構造的に消え、(b) 「1 回だけ決まる値」であることが型で表現され、(c) テストは `startServer(cfg, { shutdownTimeoutMs: 0 })` で同じ決定性を得られる。`ServerConfig` は 3 分岐の union なので、フィールド追加ではなく**第 2 引数**にするのが差分最小。

- **[W-004]** ADR-005 の削除基準が `watcher` に一貫して適用されていない。`watcher` は現在 **`src/` 内から一切読まれていない完全な dead field** であり、`server.watcher.close()` は「ライブリロードだけを黙って殺す」部分シャットダウン経路そのものである。
  - 場所: `src/server/index.ts:46`（`readonly watcher: FileWatcherHandle;`）/ `.issue/102/adr.md` ADR-005
  - 理由:
    - `grep -rn "\.watcher\|watcher:" src` の結果、`ServerInstance.watcher` の**参照は宣言行のみ**。テストも `shutdown` しか使っていない。`close` / `sseCloseAll` と同じく完全未使用である。
    - ADR-005 の基準は「未使用**かつ**誤用によって本 Issue のハング（**またはそれに準ずる不整合状態**）を再現できる」。`FileWatcherHandle.close()`（`src/lib/watcher.ts:69`）は公開されており、`server.watcher.close()` を単独で呼ぶと **HTTP サーバーと SSE ストリームは生きたままファイル監視だけが死に、ブラウザは接続を保ったまま永遠に更新を受け取らない**。これは ADR-005 が `sseCloseAll` の削除理由に挙げた「SSE は死んだがサーバーは生きている不整合」と同型の不整合であり、括弧内の「それに準ずる不整合状態」に該当する。「ハングを再現できるか」だけを見て `watcher` を除外するなら、基準の括弧内の文言と齟齬がある。
    - 「既存のシェイプを不必要に変えない」という理由も、同じ PR で `close` / `sseCloseAll` を消していることと釣り合わない。
  - 提案: どちらかに倒す。(a) `watcher` も削除して `ServerInstance` を `{ shutdown }` の 1 メソッドにする（`package.json` に `exports` が無く外部コンシューマは存在しないため非破壊なのは ADR-005 の言うとおり）。(b) 残すなら基準の文言を「**ハングを再現できる**」に限定して括弧内の「それに準ずる不整合状態」を削り、「`watcher` は将来の観測用に意図的に残す」と Consequences に書く。現状の「基準を明文化して一貫性を担保した」という主張は、この 1 点で成立していない。

- **[W-005]** `SseManager.shutdown` の型側 doc が `see \`createSseManager()\`` を指しているが、**`createSseManager()` には doc コメントが無い**。`ServerInstance.shutdown` と同名・別粒度である以上、型定義側で責務差が読めるべき。
  - 場所: `src/server/routes/sse.ts:13-14`（型 doc）/ `:20`（`createSseManager` に JSDoc なし）/ `:30-36`（実 doc は内部関数側）
  - 理由: エディタのホバーや `import type { SseManager }` した読者が見るのは型側の doc である。そこから「`createSseManager()` を見ろ」と誘導されて開くと、その関数にはコメントが無く、内部のローカル関数まで降りないと説明に辿り着かない。しかも `ServerInstance.shutdown`（プロセス全体のライフサイクル終端）と `SseManager.shutdown`（SSE サブシステムのみの終端）は粒度が違い、`src/server/index.ts:226` では `sse.shutdown()` が `shutdown()` の**ステップ 1**として呼ばれる。この入れ子関係こそ型側 doc に書くべき情報。
  - 提案: 型側に 2 行で書き切る。例:
    ```ts
    /**
     * SSE サブシステムのみを終端する（`ServerInstance.shutdown` の手順 1 に相当）。
     * 以後 `/sse` は 503 を返し、`broadcast()` は no-op になる。再開はできない。
     */
    readonly shutdown: () => void;
    ```
    命名自体は許容範囲（層が違えば同名でよい）だが、`sse.shutdown()` / `server.shutdown()` が同一ファイル内で並ぶため、doc での区別は必須。

- **[W-006]** `withTimeout` の doc コメントが実装より長く、ADR の議論をそのまま持ち込んでいる。plan.md 自身が「この判断理由を実装時に doc コメントへ **1 行**残す」と書いていた箇所が 4 行になっている。comment-cleanup 方針と衝突する。
  - 場所: `src/lib/with-timeout.ts:13-37`（25 行の JSDoc）+ `:1-7`（7 行の module doc）に対し、実装は `:38-64` の 26 行
  - 理由: 「なぜ」を書くのは正しいが、次の 3 つは**ADR に属する内容**でコードには不要:
    - `:23-26`「これがタイムアウト分岐を決定的にテスト可能にする — `setTimeout(0)` との race ではできない、なぜなら `server.close()` のコールバックは…」（テスト戦略の正当化）
    - `:29-31`「(Implementation note: 予算ゼロ分岐は executor 内で同期 resolve するが、`await` への配送は必ずマイクロタスク経由…)」（Promise の一般論。ここで説明する必要がない）
    - `:33-36` の unref 4 行（plan では 1 行の指定）
    これらを ADR-001 に委ねれば、doc は「契約（3 帰結 + 予算ゼロの意味）」＋「unref しない理由 1 行」＋「詳細は `.issue/102/adr.md` ADR-001」に圧縮でき、実装より短くなる。
  - 提案: 契約と「なぜ unref しないか」の要約 1 行だけ残し、残りは ADR 参照 1 行に置換する。逆に `:43` の「Keep a rejection handler attached so a later rejection is not unhandled.」は短く必須の why なので残すべき（ただし W-001 の修正でここの記述も直る）。

- **[W-007]** CLI の**正常系ユーザー向け出力**に `logger.info` を混ぜており、`src/index.ts` の既存の出力規約（UX は `@clack`、診断は `logger.*`）と不一致。
  - 場所: `src/index.ts:182`（`logger.info(\`Received ${signal}, shutting down...\`)`）
  - 理由: `src/index.ts` は `@clack/prompts` の `intro` / `outro` / `log.info` / `spinner` / `cancel` でユーザー向け表示を組み立て（`:162-163` が `log.info`）、`logger.*` は**エラー診断のみ**に使っている（`:67`, `:101`, `:187`, `:214` — すべて `logger.error`）。今回追加された `logger.info` は、この PR で初めて「正常系の情報表示を `logger` で出す」ケースになり、`[peek] Received SIGINT, shutting down...` という clack の意匠から外れた行が**毎回の Ctrl+C で全ユーザーに**表示される。ADR-007 は挿入位置（`console.log()` の後・`intro()` の前）まで詰めているが、**どの出力チャネルを使うか**は検討されていない。
  - 提案: `log.info(pc.dim(\`Received ${signal}\`))` として clack 側に寄せる（`log` は既に import 済み `:7`）。あるいは真因切り分け専用の診断と割り切るなら、`process.env.PEEK_DEBUG` などでゲートして通常ユーザーには出さない。ADR-007 が「真因が判明したら削除を検討する」と書いている性質の 1 行を、恒久的な UX 出力として無条件に出すのは釣り合わない。
  - なお `logger.warn` / `logger.error` の使い分けは既存慣習と一致している（N-006 参照）。この指摘は `logger.info` の 1 箇所に限る。

- **[W-008]** `src/server/shutdown-process.test.ts` は **CLI（`src/index.ts`）を spawn するテスト**だが、サーバー層のディレクトリに置かれている。リポジトリの「テストは対象モジュールと同じ場所に置く」規約から外れる。
  - 場所: `src/server/shutdown-process.test.ts:59-72`（`spawn(process.execPath, [..., "src/index.ts", ...], { cwd: repoRoot })`）、`:8`（`repoRoot`）、`:13`（`getFreePort` の複製）
  - 理由: 既存テストはすべて対象と同居している（`src/lib/watcher.test.ts` ↔ `src/lib/watcher.ts`、`src/server/routes/sse.test.ts` ↔ `sse.ts` 等）。このテストの被験体は `src/index.ts` であって `src/server/` の何かではない。`repoRoot` を `import.meta.dirname/../..` で組み立てているのも、置き場所が実態とずれている兆候である。加えて `getFreePort()` を `index.test.ts` から複製しており（コメントで「意図的」と断ってはいる）、同じ層に置けば重複の判断もしやすい。
  - 提案: `src/index.test.ts`（新規）か、プロセス起動を伴う E2E として `test/` などの独立した場所に移す。移すのが本 PR のスコープ外なら、ファイル冒頭に「CLI 層の E2E。`src/server/` に置いているのは暫定」と 1 行残すこと。

#### Notes

- **[N-001]** `Result<T, E>` を使わず `TimeoutOutcome<T>` を新設した判断は**結論としては妥当**だが、ADR-001 / plan.md が挙げる根拠は前提が誤っている。`src/core/result.ts:1-3` の `Result<T, E>` は `E` に何でも取れる純粋な 2 分岐 union であり、「`TypedError` は `cause: Error` を必須とする」は `Result` の制約ではない（`Result<void, "timed-out">` と書けてしまう）。ただし `grep` した結果、リポジトリ内の `Result` の `E` は実際すべて `TypedError` 派生（`ReadTextFileError` / `BuildTreeError`）であり、**慣習としては** ADR の言うとおり。より正確な根拠は「タイムアウトは失敗ではなく期待される分岐なので `ok/error` の語彙に載せない」の 1 点で足りる。根拠の書き換えを推奨する（結論の変更は不要）。

- **[N-002]** `withTimeout(p, 0)` を「常にタイムアウト」とする扱いは、**契約として一貫している**と判断した。「最大 0ms 待つ」＝「待たない」＝「予算を使い切った」であり、特別扱いというより関数の自然な極限である。`!(timeoutMs > 0)` で `NaN` も同じ側に落とす判定は、型で防げない入力に対する全関数化として素直で、doc（`:21-28`）も驚きうる読者への注意を含めて十分に説明している。テスト注入のためだけの特別扱いか、という問いには「結果的にテスト注入に使えるが、意味論としては独立して正当化できる」と答える。ただし W-003 のとおり、**注入点を `shutdown()` の毎回引数にした**ことは別の問題である。

- **[N-003]** `let shuttingDown = false`（`src/server/routes/sse.ts:22`）は CLAUDE.md の「ステートレスな純粋関数型スタイル」から外れるが、`createXxx` がクロージャに状態を隠して `readonly` メソッド群を返すという**リポジトリ既存のハンドル型パターン**（`FileWatcherHandle` の `let closed`、`ServerInstance` の `shutdownPromise` / `closePromise`）と完全に一致しており、この追加自体は妥当。より宣言的な代案として、ADR-003 が却下した c 案は「per-client の keep-alive 待機を `AbortSignal.any([clientSignal, managerSignal])` で待つ」案であり、却下理由は「client あたりのアロケーションを増やす価値が無い」だった。**マネージャ単位の `AbortController` を『フラグそのもの』としてだけ使う（`controller.signal.aborted` を読む / `shutdown()` で `abort()` する）変種は、per-client のアロケーションを 1 つも増やさないので、この却下理由の射程外**である。とはいえ boolean 1 個より複雑になるだけで得るものが無いため、**現状維持を支持する**。ADR を蒸し返す必要はない。

- **[N-004]** `src/index.ts:172` の `const shutdown = async (signal: NodeJS.Signals) => {...}` は `process.on("SIGINT", shutdown)` と型整合している。`@types/node@25.9.1` の `process.d.ts:119` が `SignalsEventMap = { [S in NodeJS.Signals]: [signal: S] }` を定義しており、`"SIGINT"` に対して期待されるのは `(signal: "SIGINT") => void`。パラメータは反変なので `NodeJS.Signals` を受ける関数は代入可能、返り値 `Promise<void>` も `void` 期待の位置に置ける。問題なし。なお async ハンドラなので、`server.shutdown()` 以外（`outro()` / `logger.info`）が throw すると unhandled rejection になるが、実質到達しないため指摘に含めない。

- **[N-005]** **計画との乖離なし**を実コードで確認した。「不採用」4 項目はいずれも実装に存在しない: stdio drain なし（`src/index.ts:186-192` に `await` 追加なし）、打ち切り時の再 `closeAllConnections()` なし（`src/server/index.ts:239-245` は `logger.warn` のみ）、`closeIdleConnections()` の呼び出しなし、`broadcast()` の `shuttingDown` ガードなし（`src/server/routes/sse.ts:24-28` は変更されておらず、代わりに `shutdown` の doc `:34-35` で「以後 no-op」を契約として明示 — plan の指示どおり）。逆方向の実装漏れも見つからなかった（ステップ 1〜8 すべて反映済み）。

- **[N-006]** `logger` の使い分けは既存慣習と一致している。`logger.warn` はリポジトリ内で「回復可能だが記録したい事象」に使われており（`src/lib/watcher.ts:41`, `:63` の watcher エラー）、シャットダウン打ち切り（`src/server/index.ts:242`）はまさにその性質。`logger.error` は致命的失敗（`src/index.ts:67`, `:101`, `:187`, `:214`）で、こちらも踏襲されている。指摘は `logger.info` のみ（W-007）。

- **[N-007]** `src/server/shutdown-process.test.ts` の待ち時間設計が `vitest.config.ts` の `testTimeout: 30000` と競合しうる。`waitForServer(port, 20_000)` + SIGINT 後の `killTimer` 10_000ms = 最大 30 秒で、vitest 側のタイムアウトとほぼ同値。起動が遅い環境では**自前の診断パス（`Output:\n${output}` 付きのエラー / `SIGKILL`）に到達する前に vitest が先にテストを落とし、spawn した子プロセスが残留する**可能性がある。`waitForServer` を 10 秒程度に縮めるか、`testTimeout` をこのテストだけ延ばす（`it(..., { timeout: 60_000 })`）ことを推奨。

- **[N-008]** **レビュー対象外の未コミット変更**が作業ツリーに存在する。`src/server/index.ts:229` に `await new Promise((r) => setTimeout(r, 0));` が手順 1 と 2 の間に挿入された状態で残っている（`git diff` で確認、PR 差分には含まれない）。おそらくレースを再現するための検証用の残骸。**そのままコミットされると `src/server/index.test.ts` の「stops accepting connections before shutdown() is awaited」が落ち、ADR-002 が保証すると宣言した「`shutdown()` から戻った時点でリスナーは閉じている」契約も破れる**ため、コミット前に破棄すること。本レビューの指摘は `HEAD`（コミット済み）の内容に対して行っている。

---

## 良かった点（記録）

- **`server.close()` を破棄より先に呼ぶ順序変更**（`src/server/index.ts:225-237`）と、手順 1〜5 の番号付きコメント。「順序が本質である」ことが番号と各行の why で明確に伝わっており、過剰でもない。この PR で最も価値の高い変更。
- **`stream.write()` の `.catch(cleanup)` 削除**（`src/server/routes/sse.ts:96-99`）。`node_modules/hono/dist/utils/stream.js:34-42` を実際に読んで確認した — `write()` は `try { await this.writer.write(input); } catch {}` で例外を握り潰して必ず resolve するため、`.catch()` は到達不能なデッドコードだった。削除は正しく、残したコメントも正確。
- **`client.send` 側の `writeSSE(...).catch(cleanup)` を残した判断**（`:67`）も正しい。`writeSSE` は `event` / `id` に改行が混ざると throw しうる。片方だけ消す判断が両方とも根拠を持っている。
- **`node:timers/promises` への置換**（`:89-91`）。`{ once: true }` の誤解に由来するリスナーリークという、Issue 調査で唯一実測できた欠陥への対処。標準 API 化により abort 済み signal での即 reject も得られている。
- **二重チェック（フラグ立て→走査 / 登録→再チェック）の証明が Hono の実装詳細に依存していない**点。`:76-84` のコメントが「どちらの順でも取りこぼさない」理由を短く言い切れており、fast path / `compose` 経路のどちらでも成立する。
- `close()` の memo 化（`src/server/index.ts:208-216`）と `ERR_SERVER_NOT_RUNNING` を理由として書いたコメント。
- ADR が**撤回した判断（unref / stdio drain / 再 `closeAllConnections()`）の経緯を実測値とともに残している**こと。将来同じ提案が出たときに議論を再演しないで済む。
