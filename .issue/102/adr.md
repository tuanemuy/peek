# ADR — Issue #102: Ctrl+C でシャットダウンが無限ハングすることがある（SSE 再接続のレースで server.close() が解決しない）

## ADR-001: 構造的レース対策とタイムアウトの二層構成（どちらが主か）

### Status
Proposed（「reject 透過の範囲」と「`src/lib/` 配置の根拠」をレビューで改訂）

### Context

Issue には 3 つの修正案が挙がっている。

1. 新規接続を先に止める（`server.close()` を先に呼ぶ + SSE 側のシャットダウン中フラグ）
2. `await close()` にタイムアウトを設け、超過したら `process.exit(0)`
3. `closeIdleConnections()` の併用

「レースを根本的に塞ぐ」か「タイムアウトで誤魔化す」かの選択に見えるが、調査で前提が崩れた。

**Issue 記載のレースは現行コードでは成立しない**（2 名のレビュアーが独立に検証して一致）。`shutdown()` の本体は `sseCloseAll()` → `watcher.close()` → `closeAllConnections()` → `server.close()` まで `await` を 1 つも挟まない同期ブロックであり（`close()` の Promise executor は同期実行される）、`net.Server.prototype.close` はその場でリスニングハンドルを閉じる。SIGINT ハンドラも `connection` / `request` イベントもマクロタスクであり、**マイクロタスクは次のマクロタスクの前に必ず全て流れる**ため、この 2 つが interleave することはない。

さらに真因の再調査でも再現できなかった。Node 22.22.1 / macOS 上で、実シナリオ 8 種、40 接続の再接続ストーム、送信バックプレッシャー下でのシャットダウン、実 CLI への実 SIGINT 12 回を試して**ハングは 0 件**。`closeAllConnections()` は全ケースで `server._connections` を同期的に 0 にし、`server.close()` は最大 3ms で解決した。

したがって:

- 「`closeAll()` の後に `clients` へ追加される client」は現行コードでは発生せず、**真の原因は未特定**である。残る有力な変数は **Node のバージョン差**（報告者 v24.15.0 / 検証 v22.22.1）、次点で **SIGINT ハンドラ自体が起動していなかった可能性**（Issue の「SIGTERM で即座に終了した」という観測は両方と整合する）。
- 一方、現行の安全性は「たまたま `await` が無い」ことに依存しており、その制約はコメントにも型にも記されていない。**将来 `await` が 1 つ入れば Issue 記載のレースは本当に発生する。**

選択肢:

- **A. 構造対策のみ** — 原因未特定なので要件「Ctrl+C で必ず終了する」を保証できない。
- **B. タイムアウトのみ** — 症状は必ず止まるが、既存の暗黙の脆さ（`await` を 1 つ入れれば壊れる構造）が残る。
- **C. 両方** — 二層。

### Decision

**C を採る。ただし従来の直感とは逆に、役割を次のように明確化する。**

- **タイムアウト（有界シャットダウン）を「要件充足の保証」とする。** 原因が特定できていない以上、終了性を保証できるのはこれだけである。「誤魔化し」ではなく、原因不明の資源リークに対する唯一の正しい防御。
- **構造対策（`server.close()` を先に呼ぶ順序 + SSE シャットダウン中フラグ + 登録後の再チェック）を「再発防止」として従に置く。** 現状の安全性を「同期実行という偶然」から「フラグと再チェックという構造」へ移し、将来の変更に対して堅牢にする。これは推定原因を潰すためではなく、**既知の脆さを消す**ために入れる。**この主従関係を PR 説明でも曖昧にしない。**
- **観測性を追加する。** タイムアウトが発火したら `logger.warn` を出し、CLI では受信シグナル名をログに出す（ADR-007）。これが「構造対策で直ったのか、タイムアウトに救われているだけなのか」「そもそも SIGINT ハンドラが起動したのか」を切り分ける唯一の手掛かりになる。

**`process.exit(0)` はサーバー層に置かない。** Issue の修正案 2 は `process.exit(0)` によるフォールバックを提案しているが、`src/server/index.ts` からプロセスを殺すのは層の責務違反であり、テストで `shutdown()` を呼ぶとテストランナーごと落ちる。代わりに `shutdown()` がタイムアウト時も **resolve** し、既存の CLI（`src/index.ts`）の `await server.shutdown()` → `process.exit(0)` に到達させる。プロセス制御は現状どおり CLI 層の単独責務のままにする。

タイムアウト値は `SHUTDOWN_TIMEOUT_MS = 2_000`（`src/server/index.ts` のモジュール定数）。`closeAllConnections()` の後は 1 ティックで解決するのが正常系なので過剰だが、低速環境で正常系を誤って打ち切って偽陽性の警告を出さないためのマージン。ユーザー体感としても 2 秒は許容範囲。**受け入れ基準の閾値（プロセス終了 5 秒以内）は「タイムアウト値 2 秒 + 実行オーバーヘッドの上限」として定義し、この定数と整合させる。**

タイムアウト機構は `src/lib/with-timeout.ts` に純粋ユーティリティとして切り出す。理由は **テスト可能性**: 実サーバーでは「close が永久に解決しない」状況を作れないため、この関数の単体テストが「必ず有限時間で settle する」ことを検証できる唯一の場所になる。返り値は `Result<T, E>` ではなく専用の判別可能ユニオン `TimeoutOutcome<T>` とする（`TypedError` は `cause: Error` を必須とするが、タイムアウトには自然な `cause` が無く、そもそも「エラー」ではなく期待される分岐だから）。

**元 Promise の reject の透過は「予算内に reject した場合のみ」である（記述を改訂）。** 当初の「reject は透過させ、既存挙動を維持する」という記述は不正確だった。実際には次の 3 帰結になる。

1. 予算内に fulfill → `{ status: "completed", value }`。
2. 予算内に reject → **その reject を透過する**（`server.close()` のエラーが CLI の `logger.error` に届く既存挙動はここで維持される）。
3. 予算超過後の reject／予算ゼロ経路の reject → **購読はするが破棄される**。outer promise は既に settle 済みなので、どこにもログを残さない。

3 の経路を無くすには `TimeoutOutcome<T>` に `{ status: "failed"; error }` を足す案もあるが、`close()` の memo 化により `ERR_SERVER_NOT_RUNNING` が起きず到達可能性が極めて低いこと、および 3 分岐を `shutdown()` 側で扱うと打ち切り後の後始末という別の判断を呼び込むことから、**実装は変えず doc コメントの記述を事実に合わせる**にとどめる。2 の経路（予算内の reject）を `shutdown()` 側がどう扱うかは ADR-002 で決める — `withTimeout` の呼び出しを `try`/`catch` で包めば `TimeoutOutcome` を 3 分岐にしなくても失敗チャネルは分離できるので、`withTimeout` の型はタイムアウトという 1 つの関心だけを表現したままにする。

**予算ゼロ（判定は `!(timeoutMs > 0)`）は「常にタイムアウト」として、`promise` の settle 順序と無関係に決定的に `{ status: "timed-out" }` を返す。** これは意味論として素直であるだけでなく、**タイムアウト分岐（`logger.warn`）を自動テストに載せるための鍵**である。素朴に `setTimeout(0)` と race させる実装では踏めない — `server.close(cb)` のコールバックは `setTimeout(0)` のマクロタスクより必ず先に流れるため、`timeoutMs: 0` でも `completed` になってしまう（`closeCb -> setTimeout0` の順に流れることを実測）。

- **契約の書き方**: 実装としては executor 内で同期的に resolve する（または `Promise.resolve(...)` を早期 return する）が、**契約の記述に「同期的に resolve する」とは書かない**。Promise の resolve を executor 内で同期的に呼んでも `then` / `await` への配送は必ずマイクロタスク経由になるため、呼び出し側から見れば `withTimeout(p, 0)` も `withTimeout(p, 2000)` も等しく非同期である。「同期 resolve」は「同期関数として値が返る」と誤読されうるので、doc コメントは「`promise` の settle 順序と無関係に決定的に `timed-out` を返す」と書く。実装方法としての併記は可。
- **判定式は `timeoutMs <= 0` ではなく `!(timeoutMs > 0)`**。`NaN` は `NaN <= 0` が **false** になるため前者では `setTimeout(NaN)` 経路に落ちる（本計画で実測: 約 3ms 後に発火）。`!(NaN > 0)` は **true** なので後者なら `NaN` も予算ゼロに落ちる。呼び出し元は `shutdown()` の 1 箇所で既定値も `2_000` なので実害は無いが、型で防げない入力に対する全関数化としては後者が素直（CLAUDE.md の型安全性志向とも整合）。`startServer()` 側も `options?.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS`（ADR-008）として `{ shutdownTimeoutMs: undefined }` が予算ゼロに落ちないようにする。**`0` / 負数 / `NaN` が「即座に諦めて警告を出す」を意味することは、非公開の `withTimeout` ではなく公開面である `StartServerOptions.shutdownTimeoutMs` の doc に書く**（既定値の実数も併記する。`SHUTDOWN_TIMEOUT_MS` は非 export なので型定義側から辿れないため）。

実測（本計画）:

| 相手の Promise | `withTimeout(p, 0)` の結果 |
|---|---|
| `process.nextTick` で解決（20 回） | 20/20 `timed-out` |
| 実 `server.close()` のコールバック（10 回） | 10/10 `timed-out` |
| SSE 接続を張った実サーバーのシャットダウン手順（10 回） | 10/10 `timed-out` + `logger.warn` 発火 |
| 同上・既定 2000ms（10 回） | 10/10 `completed` + 警告 0 件（偽陽性なし） |

この経路でも `promise.catch(() => {})` を必ず張り、後から reject しても unhandled rejection にしない。

**タイマーは `unref()` しない（計画段階の方針を撤回）。** 当初は「unref しないとタイムアウト時間だけイベントループが生き延び、テストの teardown が遅延する」という理由で `timer.unref()` を採用する計画だった。本計画で 4 パターンを実測した結果、この理由は成立せず、逆に unref が観測性を失う経路を持つことが確認できたので撤回する。

| ケース（タイムアウト 300ms、Node 22.22.1 / macOS） | 結果 |
|---|---|
| `unref()` あり・`promise` 未解決・他に ref 付きハンドル無し | **1ms でプロセスが自然終了。警告も `outro()` も `process.exit(0)` も走らない**（exit code 0） |
| `unref()` なし・`promise` 未解決・他に ref 付きハンドル無し | 306ms でタイムアウト発火 → 警告出力 → 正常終了（exit code 0） |
| `unref()` あり・`promise` 未解決・ref 付きハンドルあり（= 本 Issue の症状） | 306ms でタイムアウト発火 → 警告出力（unref でも害は出ない） |
| `unref()` なし・`promise` が 10ms で解決 | **14ms でプロセス終了**（`clearTimeout` により teardown は遅延しない） |
| `unref()` なし・`clearTimeout` を落とした場合 | completed 後も **303ms** 生き残る（= teardown 遅延を防いでいるのは `clearTimeout` であって `unref()` ではない） |

- 撤回理由 1: **「teardown が遅延する」は偽。** `promise` が settle した時点で必ず `clearTimeout` するため、ref 付きのままでもタイマーが待機を延ばすことはない。`withTimeout` の全経路（予算ゼロの早期 return / 期限内 settle / タイムアウト発火）でタイマーは「張られない」「クリアされる」「発火して消費される」のいずれかであり、生き残る経路が存在しない。**したがって `unref()` を外してもテストの teardown への影響は無い。**
- 撤回理由 2: **unref には実害がある。** 「`server.close()` のコールバックが来ないが ref 付きハンドルも残っていない」という状況では、unref 済みタイマーは発火せず、本 ADR が「真因切り分けの唯一の手掛かり」と位置づけた `logger.warn` ごとシャットダウンの終盤（`outro()` / `process.exit(0)` を含む）が丸ごとスキップされる。本 Issue の症状（ハング）では ref 付きハンドルが残っているので実際には発火するが、要件（AC-1）と観測性（AC-3）の両方を守る側に倒すなら ref のままが素直である。
- この判断理由を実装時に doc コメントへ 1 行残す。

**配置は `src/core/` ではなく `src/lib/` とする。ただしこの判断は「守らないと壊れる制約」ではなく「既存の並びに合わせる」だけのものである（根拠を 2 度書き直した末の結論）。**

先に、**採用しなかった 2 つの根拠と、それが誤りである理由**を記録する。同じ提案が再演されないために必要な部分である。

1. **「`withTimeout` はタイマーという副作用をスケジュールするから」（＝ `src/core/` は純粋・`src/lib/` は副作用）** — 分割として成立していない。`src/lib/node-error.ts` や `src/lib/markdown.ts` は副作用を持たない。しかも `.issue/89/adr.md` ADR-001 が定めた既存の基準は「`src/core/` はフレームワーク／ランタイム非依存層」であり、`withTimeout`（import ゼロ、ブラウザにも存在する API しか使わない）はその基準では `src/core/` 側に落ちる。既存の基準を後から書き換えるのは筋が悪い。
2. **「`src/core/` はクライアントバンドルに載る層だから、サーバー専用のものを置くとバンドルが太る」** — **事実として誤り**。`scripts/build-client.mjs` は `entryPoints: ["src/client/entry.tsx"]` + `bundle: true` で esbuild を呼ぶので、**バンドルに入るのはエントリから import 到達可能なモジュールだけ**であり、ディレクトリ所属は無関係である。生成済みの `src/server/renderer/client-bundle.js`（32,558 バイト）を実際に検査して確認した:

    | 検出したい文字列 | 由来（`src/core/` にあるがクライアントから import されていない） | バンドル内 |
    |---|---|---|
    | `node:path` | `path.ts` | false |
    | `flatMap` / `mapError` / `getOr` | `result.ts` | false |
    | `typedError` | `error.ts` | false |

    そもそも `src/core/path.ts` は `node:path` を import しており、丸ごと載るならブラウザ用バンドルが壊れる。ビルドが通っている時点でも同じ結論になる。したがって `withTimeout` を `src/core/` に置いてもバンドルは 1 バイトも太らない。

**では正しい根拠は何か。** 実測すると、**どちらのディレクトリでも壊れない**というのが答えである。

- 既存の明文化された基準（`.issue/89/adr.md` ADR-001）は「ランタイム依存のものは `src/core/` に置かない」という**一方向の除外規則**でしかなく、「ランタイム非依存なら `src/core/` に置け」とは言っていない。`withTimeout` はこの規則に抵触しない。
- 「`src/core/` = client / server 双方が使う共有層」という説明も、**事実として成り立たない**。実測（`src/client/**`・`src/components/**` からの import 有無）では `src/core/error.ts` / `path.ts` / `result.ts` はクライアントから 1 度も import されておらず、サーバーからのみ使われている。
- 逆命題「`src/lib/` = サーバー専用」も成り立たない（`src/lib/logger.ts` は `src/client/lib/sse.ts` から import されている）。

残るのは**中身から読み取れる事実上の区分**だけである。`src/core/` に入っているのは peek のドメイン語彙（`Result` / `TypedError` / file-tree の形 / content-type / SSE 定数）であり、`src/lib/` に入っているのは具体的な基盤ヘルパ（logger / markdown / watcher / file-tree-cache / styles / project-id / node-error）である。`withTimeout` は後者であり、利用者も `src/server/index.ts` の `shutdown()` ただ 1 箇所しかない。**よって `src/lib/` に置くが、これは「バンドルが太るから」でも「ランタイム依存だから」でもなく、単に同種のヘルパの隣に置くという以上の意味を持たない。**

この結論に伴い、**配置根拠は実装の doc コメントから外す**。誤った基準が恒久的なコードコメントとして残ると将来のコントリビュータの配置判断を誤らせるのに対し、正しい基準は「どちらでもよい」なのでコメントに書く価値が薄い。`src/lib/with-timeout.ts` にはこの ADR への参照 1 行だけを残す。

### Consequences

- 良い点: Ctrl+C の終了性が原因に依存せず保証される。同時に、暗黙の同期依存という既知の脆さが消える。警告ログにより再発が可視化される。
- 良い点: `process.exit` がサーバー層に漏れないので `shutdown()` はテストから安全に呼べる。
- 良い点: 予算ゼロ（`!(timeoutMs > 0)`）の特別扱いにより、**タイムアウト分岐と警告出力が自動テストで担保される**（AC-3）。当初の計画では手動確認のみだった。
- 良い点: `unref()` を採らないことで、タイムアウト時の警告（真因切り分けの唯一の手掛かり）が「他に ref 付きハンドルが無い」ケースでも失われない。
- トレードオフ: 予算ゼロが「即タイムアウト」になるのは、素朴に読むと「即座に諦める」であって直感に反しない一方、`withTimeout(p, 0)` に「0ms 待つ = ほぼ即座に完了を確認する」を期待するコードがあれば壊れる。呼び出し箇所は `shutdown()` 1 箇所のみで、`timeoutMs` の既定値は `SHUTDOWN_TIMEOUT_MS = 2_000` なので実害は無い。doc コメントに明記する。
- トレードオフ: `unref()` を使わないため、`clearTimeout` の漏れがそのままテスト/プロセスの終了遅延として現れる（実測: 300ms のタイムアウトで `clearTimeout` を落とすと 303ms 生き残る）。これは欠点でもあるが、漏れが可視化されるという意味では検出しやすい方向の失敗であり、ステップ 2 の単体テストが担保する。
- トレードオフ: `src/lib/` / `src/core/` の境界は本 ADR でも確定しなかった（既存の基準は除外規則でしかなく、中身の並びも一貫していない）。`withTimeout` の配置はどちらでも壊れないため実害は無いが、境界を明文化するのは本 Issue のスコープ外とした。
- トレードオフ: タイムアウトが真の原因を隠しうる。→ 警告ログ・シグナル受信ログと手動確認での記録で緩和する。自動テストが担保するのは「警告経路が存在すること」「正常系で偽陽性が出ないこと」までで、実運用で警告が出ているかどうかは手動確認の記録でしか分からない。
- トレードオフ: 打ち切りで終了しても exit code は 0 のまま（`process.exit(0)`）。読み取り専用のプレビューサーバーであり、失敗として扱う必要が無いため許容する。
- トレードオフ: 「原因未特定」を前提に据えるため、本 Issue のクローズは「ハングが再発しないこと」の確認であって「原因の解明」ではない。手動確認（10 回）は統計的な証明力を持たないため、真因追跡は Node 24 での検証（CI matrix による自動実行 + plan のステップ 9 の macOS / 実ブラウザ確認）と、シグナル受信ログ（ADR-007 (3)）による次回再発時の切り分けに委ねる。

---

## ADR-002: `server.close()` を手順 1 に置き、手順ごとにエラーを分離する（`closeIdleConnections()` は併用しない）

### Status
Proposed（レビューで手順順序を改訂し、エラー分離を追加した後、分離の粒度と失敗の集約方法をさらに改訂）

### Context

現行の順序は `sseCloseAll()` → `watcher.close()` → `closeAllConnections()` → `server.close()`。すなわち **接続を破棄してからリスナーを閉じている**。破棄はブラウザの再接続を誘発するため、論理的に危険な順序である（現行は同期実行のおかげで実害が出ていないだけ）。

また Issue の修正案 3 は「`closeIdleConnections()` の併用」**および**「close 完了までの間に張られた接続も確実に破棄する」の 2 部構成になっている。

### Decision

順序を次のように変える。

```
   const failures: unknown[] = []
   const step = (run) => { try { run() } catch (error) { failures.push(error) } }

1. const closing = close()               // server.close(): リスナー停止（新規接続の受付を止める）
2. step(() => sse.shutdown())            // 新規 /sse を拒否し、既存ストリームを abort
3. step(() => watcher.close())           // これ以上 broadcast を発生させない
4. step(() => { if ("closeAllConnections" in server) server.closeAllConnections() })
                                         // 送信中の SSE を抱えた active ソケットを destroy
5. try {
     const outcome = await withTimeout(closing, shutdownTimeoutMs)
     if (outcome.status === "timed-out") logger.warn(...)  // 追加の後始末はしない（ADR-007）
   } catch (error) { failures.push(error) }

   if (failures.length === 1) throw failures[0]
   if (failures.length > 1) throw new AggregateError(failures, "Failed to shut down the server.")
```

**`close()` を手順 1 に置く（レビューを受けた改訂）。** 当初の計画は `sse.shutdown()` を手順 1、`close()` を手順 2 としていたが、これは**この ADR 自身が掲げる根拠と矛盾していた**。旧手順 2（`close()`）のコメントは「再接続を誘発しうる操作より前にリスナーを止める」と書いていたのに、その前に走る `sse.shutdown()` こそが、接続中の SSE ストリームを全部終端させてブラウザの `onerror` → 自前 `setTimeout(connect, delay)` を誘発する操作である（`src/client/lib/sse.ts` / `src/server/renderer/html-document.tsx`）。つまり不変条件は「手順 1〜4 の間に `await` が無い」という**偶然**によってのみ守られており、ADR-001 が消そうとしている依存そのものだった。`close()` を先頭に置けば根拠と実装が一致する。**Issue 本文の修正案 1（「まず `server.close()` を呼んで新規接続の受付を止めてから、SSE ストリーム / ソケットを閉じる」）とも一致する。**

入れ替えで壊れるものが無いことは確認済みである。`sse.shutdown()` は `shuttingDown` フラグを立てて `clients` を走査するだけで、リスナー閉鎖の前後を問わず取りこぼさない（ADR-003 の二重チェック）。むしろリスナーを先に閉じることで、シャットダウン後の `/sse` は 503 に到達する前に TCP レベルで拒否されるようになる。

**エラー分離は「手順 2〜4 をまとめて 1 つの `try` に入れる」ではなく「手順ごとに個別に捕捉する」。** 旧構造では手順 1〜4 のいずれかが throw すると `withTimeout` に到達せず、(a) `closing` に reject ハンドラが一切付かないまま残り（unhandled rejection の芽）、(b) 有界待機が行われないままシャットダウンが失敗する。`close()` を手順 1 に移すことで「`closing` が生成されない」経路は消え、手順 2〜4 を単一の `try` で囲むことで (b) も消えた。**しかしそこで止めると、手順 2 の throw が手順 3・4 を巻き添えにする。** 手順 4（`closeAllConnections()`）は「有界待機に落ちずに速く終わる」ことを担保している唯一の手順なので、これが飛ぶと毎回タイムアウト予算をフルに使うことになる。**分離の粒度が目的と合っていなかった。**

フォールト注入で実測した（隔離 worktree、実施後に撤去。SSE 接続 1 本を張った状態、予算は既定の 2,000ms）:

| 構造 | 手順 2 に throw を注入したときの `shutdown()` 所要時間 |
|---|---|
| 手順 4 が飛ぶ（単一 `try`／手順 4 を無効化した対照） | **2,003ms**（`did not close within 2000ms` の警告付き） |
| 手順ごとに個別捕捉（採用形） | **1ms**（警告なし。手順 4 が走るため） |

したがって **`step(run)` ヘルパで手順 2 / 3 / 4 をそれぞれ独立に捕捉する**。どの手順が失敗しても残りの手順は必ず実行され、手順 5 の有界待機にも必ず到達する。

**失敗チャネルは 1 本ではなく配列にする。** 捕捉したエラーを `{ error: unknown } | undefined` という単一スロットに入れる形だと、`withTimeout(closing, ...)` が予算内に reject した場合に `await` がそのまま throw して `if (failure) throw failure.error` に到達せず、**捕捉済みのエラーがどこにも記録されずに消える**。旧構造でのフォールト注入（手順に throw を注入しつつ `close()` を 5ms 後に reject させる）でも、`shutdown()` が reject した値は `close()` 側のエラーだけだった。独立した 2 つの失敗が 1 つのスロットを奪い合う構造だったので、**両方を保持できる形に変える**。

- 手順 5 も `try`/`catch` で包み、`closing` の reject を `failures` に**追加**する（丸ごと握り潰さない）。この経路ではタイムアウト警告は出さない — 予算内に reject したのであって「閉じられなかった」わけではないため。
- 失敗が 1 件なら**そのまま throw する**。`server.close()` のエラーが CLI の `logger.error` にそのまま届く既存挙動は、これで完全に維持される（実測確認済み）。
- 失敗が 2 件以上なら `AggregateError` で throw する。実測で `AggregateError.errors` に `["STEP2-FAILED", "CLOSE-FAILED"]` の両方が入ることを確認した。

**なぜ `AggregateError` か（他の選択肢との比較）。**

- **`logger.error` で個別に記録する** — 失敗は残らず出力されるが、`shutdown()` はサーバー層であり、エラーの提示先を決めるのは CLI 層の責務である（ADR-001 で `process.exit` を層から追い出したのと同じ理由）。加えて「呼び出し側に届く」チャネルが依然 1 本なので、`await server.shutdown()` を `catch` した呼び出し側から見た失敗は相変わらず 1 件のままになる。
- **`TimeoutOutcome<T>` を `{ status: "failed"; error }` の 3 分岐にする** — 型としては最も素直だが、`withTimeout` に「タイムアウト」と「対象の失敗」という 2 つの関心を持たせることになる（ADR-001）。呼び出し側で `try`/`catch` するだけで同じ分離が得られるので、公開する型を増やす必要がない。
- **`Result<T, E>`（`src/core/result.ts`）を使う** — 使わない。`Result` は「関数の返り値として成否を表す」語彙であり、ここで表現したいのは「後で throw するために保留した例外」でレイヤが違う。リポジトリ内の `Result` の `E` は実際すべて `TypedError` 派生であり、`unknown` を載せるのは慣習外である。
- **`AggregateError`** — ECMAScript 標準（`lib: ES2024`）で追加の型定義が要らず、「複数の独立した失敗をまとめて 1 つ throw する」という意味そのものである。1 件のときは包まないので既存挙動も壊さない。**到達可能性が実質ゼロの経路に新しい語彙を持ち込まない**という点で、CLAUDE.md の型安全性原則（表現できることを増やすのではなく、誤りを表現できなくする）とも矛盾しない。

**Issue 修正案 3 の後半（close 完了までの間に張られた接続の破棄）は、この順序変更によって解消される。** リスナーを先に閉じる以上、「close 完了までの間に新たに accept される接続」がそもそも存在しなくなるためである。つまり修正案 3 の後半は却下したのではなく**別の手段で満たされている**。**不採用とするのは `closeIdleConnections()` の併用のみ**である。

**`closeIdleConnections()` は採用しない。** `closeAllConnections()` はアイドル接続も含む上位互換であり、両方呼んでも追加効果は無い。`closeIdleConnections()` に意味があるのは「進行中リクエストを完走させる graceful drain」を行う場合だが、peek は読み取り専用プレビューサーバーで中断の副作用が無く、速やかな終了を優先するため drain しない。

**`closeAllConnections()` は省略不可**である点も明記する。Hono の `run()` は `cb` 解決後 `finally { stream.close() }` を呼ぶが、これは writable を閉じて HTTP レスポンスを正常終了させるだけで、**ソケットは keep-alive のアイドル状態に戻り閉じない**（`streamSSE` は `Connection: keep-alive` を明示的に付けている）。しかもその解決は abort の後の別ターンで起きるため、同期シャットダウンブロックの時点では完了していない。つまり「SSE ストリームを閉じる」だけではソケットは解放されず、`server.close()` は待ち続ける。ソケットを実際に解放しているのは `closeAllConnections()` である。

**ただし「これが無いとアイドルの keep-alive ソケットが残って `server.close()` が永久に待つ」という説明は誤りである（改訂）。** Node 19 以降の `http.Server.prototype.close` は先頭で `httpServerPreClose(server)` を呼び、その中で **`server.closeIdleConnections()` を実行している**。本 Issue の作業中に実測して確認した:

```
$ node -p "require('http').Server.prototype.close.toString()"
function close() { httpServerPreClose(this); ReflectApply(net.Server.prototype.close, this, arguments); return this; }

$ node --expose-internals -e "console.log(require('_http_server').httpServerPreClose.toString())"
function httpServerPreClose(server) { server.closeIdleConnections(); clearInterval(server[kConnectionsCheckingInterval]); }
```

`package.json` の `engines` は `>=22.0.0` なので常にこの経路を通る。したがって **アイドル接続は `server.close()` 自身が始末しており、`closeAllConnections()` が必要なのは送信中の SSE レスポンスを抱えた active ソケットに対してだけ**である。コメントの根拠が間違っていると、将来「`close()` が `closeIdleConnections()` を呼ぶなら手順 4 は不要では」と誤って削除され、SSE が残って毎回 2 秒のタイムアウトに落ちるようになる。実装のコメントもこの事実に合わせて書き換えた。

あわせて `close()`（`server.close(cb)` のラッパ）を memo 化する。`server.close()` を 2 度呼ぶと 2 回目のコールバックが `ERR_SERVER_NOT_RUNNING` を返し `shutdown()` が reject するため、内部からの二重呼び出しを構造的に防ぐ。

### Consequences

- 良い点: 「破棄 → 再接続 → accept」の経路が構造的に消える。順序に理由があることがコードとコメントに残る。Issue 修正案 3 の後半の懸念も同時に解消される。
- 良い点: 呼び出し側から見た契約が明確になる — `shutdown()` から戻った時点（最初の `await` の前）でリスナーは既に閉じている。これはテストで決定的に検証できる（80 回試行して 100% 再現を確認済み）。`close()` を手順 1 に移したことで、この契約は**他の手順の成否から独立**した。
- 良い点: どの手順が失敗しても残りの手順は実行され、有界待機にも必ず到達する。「たまたま throw しないから速い」という依存が手順 2〜4 から消えた。
- 良い点: 失敗が握り潰される経路が無い。手順 2〜4 の失敗と `closing` の予算内 reject が同時に起きても、両方が `AggregateError.errors` に載って CLI の `logger.error` に届く。
- 良い点: リスニングハンドルは手順 1 で閉じるため、タイムアウトで打ち切っても**ポートは解放済み**である（`server.close()` 呼び出し後、コールバック未発火の状態で同じポートに再 bind できることを実測で確認）。
- トレードオフ: シャットダウン中の進行中リクエスト（`/api/content` 等）が中断される。従来もほぼ同時だったため実質差は無く、意図した挙動。
- トレードオフ: 失敗が 2 件以上のとき、呼び出し側が受け取るのは元のエラーではなく `AggregateError` になる。`src/index.ts` は `logger.error` に渡すだけなので実害は無く、そもそもこの経路は現状のコードでは到達しない。

---

## ADR-003: シャットダウン中フラグは SseManager のクロージャに持ち、`closeAll` を `shutdown` に終端化する

### Status
Proposed（`onAbort` の登録順序と ② のコメント記述を改訂したのち、登録順序だけでは窓が塞がっていないことが判明して `clients.add()` にガードを追加）

### Context

「シャットダウン中フラグ」の持たせ方に複数案がある。

- a. `createSseManager()` のクロージャに `let shuttingDown` を持ち、`closeAll` を終端操作にする
- b. `closeAll` は非終端のまま残し、別途 `setShuttingDown(true)` を公開する
- c. マネージャ単位の `AbortController` を持ち、keep-alive の待機を `AbortSignal.any([clientSignal, managerSignal])` で待つ
- d. サーバー層でフラグを持ち、Hono ミドルウェアで新規リクエストを弾く

また、フラグをどこでチェックするか（ルート入口 / ストリームコールバック内 / 両方）と、拒否時に何を返すか（503 / 200 + 即クローズ）も決める必要がある。

### Decision

**a を採り、`closeAll` を `shutdown` に改名して終端操作にする。**

- `closeAll` の呼び出し箇所は listen エラー時と `shutdown()` 時のみで、いずれも「二度と使わない」。非終端の `closeAll` という用途は存在しないため、b のように 2 つの操作に分ける必要が無い。名前が実態を裏切らないよう改名する。
- 状態は `createSseManager()` のクロージャに閉じ込める。既存の `clients: Set` と同じ場所であり、`createXxx` がクロージャで状態を隠蔽して `readonly` メソッド群を返すという本リポジトリのハンドル型パターンに一致する。d（サーバー層でフラグ）だと、フラグと `clients` が別の場所に散り、両者の順序保証が層をまたいでしまう。

**順序と二重チェックが本質。**

- `shutdown()` は「`shuttingDown = true` を**立ててから**」`clients` を走査する。
- `/sse` ハンドラは「`clients.add(client)` した**直後に**」フラグを再チェックし、立っていれば即 `cleanup()` して return する。
- `stream.onAbort(cleanup)` は `clients.add(client)` の**前**に登録し、**登録は `if (!closed)` でガードする**。

**登録順序の入れ替えだけでは窓は塞がらない（改訂）。** 当初は「`onAbort` を `add` の前に移せば窓は消える（コストゼロ）」としていたが、これは事実ではなかった。`onAbort` と `add` の間に将来 `await` が入り、その窓で abort が landing した場合:

1. `cleanup()` が発火して `closed = true` になるが、`clients.delete(client)` は **client がまだ Set に入っていないので空振り**する。
2. 窓から復帰した処理が `clients.add(client)` で**死んだ client を登録する**。
3. ②の再チェックは `shuttingDown` しか見ないので素通りし、`while (!closed)` は即座に抜ける。

→ **client は `clients` に残り続ける。** 順序変更で改善されたのは「keep-alive ループが 30 秒周期で回り続けるのを止める」ことだけで、リーク自体は残っていた。フォールト注入（`onAbort` と `add` の間に人工的な `await delay(30)` を挿入し、その窓で response body を cancel して abort を起こす）で実測した:

| 実装 | 窓の中で abort したときの `clientCount` |
|---|---|
| `add` → `onAbort`（改訂前） | **1**（しかも `closed` が false のままなので keep-alive も回り続ける） |
| `onAbort` → `add`（順序変更のみ） | **1** |
| `onAbort` → `if (!closed) add`（採用形） | **0** |

**それでも順序の入れ替えは必要である。** Hono の `StreamingApi.abort()` は `aborted` フラグをラッチしたうえで**その時点で登録済みのリスナーにしか通知しない**（`node_modules/hono/dist/utils/stream.js`）。`onAbort` を後ろに置くと、窓で起きた abort は `cleanup()` を一度も呼ばないため `closed` が false のままになり、`!closed` ガードも意味を失う。**「`onAbort` を先に登録する」が `cleanup()` の到達を保証し、「`!closed` ガード」が死んだ client の登録を防ぐ — 2 つで 1 組**である。

**塞げていない窓も明示しておく。** `stream.onAbort(cleanup)` **より前**に `await` が入った場合は、abort が `aborted` にラッチされてから後発のリスナーが登録されることになり、`cleanup()` は永久に呼ばれない（`closed` は false のまま → `clients.add()` が通る）。実測でも `clientCount` は 1 になった。したがって不変条件は「**`onAbort` の登録は、`client` を組み立てた直後・他の何よりも先に行う**」である。Hono 側で `aborted` 済みの signal に対して後発リスナーを即時発火する API は無いため、これはコードの並びで守るしかない。

`shutdown()` 側の「フラグ立て → 走査」も、ハンドラ側の「登録 → 再チェック」も、それぞれ内部に `await` が無い 1 同期ブロックである。**単一スレッドでは、マイクロタスクは次のマクロタスクの前に必ず全て流れる**ため、`request` イベント由来のブロックと SIGINT ハンドラ由来のブロックは interleave できず、どちらが先でも取りこぼしが起きない。

**この保証は Hono の実装詳細に依存しない。** 現在 `/sse` はミドルウェア無しの単一ハンドラマッチなので `hono-base.js` の fast path に入り、`streamSSE` → `run` → `cb` まで完全に同期呼び出しされる。しかし `app.use(...)` を 1 つ足すと `compose` 経路に落ちてハンドラ呼び出しがマイクロタスク境界を跨ぐ。上記の議論はその場合でも成立する（同一マクロタスク内で完結するため）。ここが ADR-001 で言う「偶然から構造へ」の中身である。

**ルート入口では 503 を返す。** 理由は次の 2 点であり、**「`EventSource` が再接続しなくなるから」ではない**:

1. **意味論的に正しいステータスを in-flight リクエストに明示的に返す。** シャットダウン中のサーバーが新規ストリームを受け付けない、という状態を 503 Service Unavailable が正確に表す。
2. **ストリームを一切生成しないので軽い。** `streamSSE` の `TransformStream` / `StreamingApi` を作らずに済む。

**クライアント側の再接続挙動は 503 でも 200 + 即クローズでも同一である。** peek のクライアントは 2 実装（`src/client/lib/sse.ts` と `src/server/renderer/html-document.tsx` のインラインスクリプト）あるが、いずれも native `EventSource` の自動再接続に依存しておらず、`onerror` で `close()` してから自前で `setTimeout(connect, delay)` して新しい `EventSource("/sse")` を作る。したがって native の「非 2xx は恒久 CLOSED」仕様はこの実装には効かない。**再接続に関して本質的なのは、`server.close()` をシャットダウン冒頭（ADR-002 の手順 1）で呼ぶため、その再接続試行がそもそも TCP レベルで失敗する（`ERR_CONNECTION_REFUSED`）ことである。** 既存の指数バックオフ + 10 回上限で収束するため、無限リトライにはならない。

**ストリームコールバック内の再チェック（②）は、これとは別に必ず置く。** ただし②に落ちた場合のワイヤ上の帰結は 503 ではない: ステータスとヘッダは `streamSSE` 自身が決めるため、②で `cleanup(); return;` しても **HTTP 200 + `text/event-stream` + 即 EOF** が返る。クライアントは `onerror` → 自前リトライ → TCP 拒否で収束するため実害は無い。**①（503）は「意図を正しく表明する」ための設計、②は「取りこぼさない」ための正しさの保証**という役割分担である。

**②のコメントは「現行の Hono では到達不能である」ことを明記する（改訂）。** 当初の実装コメントは「the response was already handed back（レスポンスは既に返されている）」と書いていたが、これは**事実誤り**である — `streamSSE` は `run(stream, cb)` を `c.newResponse(...)` より**前**に呼ぶので、②を評価している時点でレスポンスはまだ返されていない。結果（200 + 即 EOF）自体は正しいので、理由づけだけを直した。

あわせて、現行の Hono では `app.get` ハンドラ → `streamSSE` → `run()` → `cb` の最初の `await` までが同一同期ブロックであり、`sse.shutdown()` も完全に同期なので、**②に落ちる経路は存在しない**（テストでも直接カバーできない）。それでも分岐を残すのは、**将来 `clients.add()` より前に `await` が入った場合（例: Hono のディスパッチが非同期化した場合）にも「取りこぼさない」保証を成立させ続けるため**である。「実際に起きるレース」と誤読されないよう、この位置づけをコメントに書く。

**c（マネージャ単位 `AbortSignal.any`）は採らない。** 既に走っている keep-alive ループの停止は次の **2 層**で漏れなく担保できるため、client あたりのアロケーションを増やす価値が無い。

1. 主: per-client の `abortController.abort()`（`shutdown()` の走査が呼ぶ）。keep-alive の待機が即 reject → `catch { break }` でループ脱出。30 秒待たない。
2. 副: `while (!closed)` と `if (!closed)` ガード。`stream.write()` 中に abort されてもその周で抜ける。

**かつて「第 3 層」として挙げていた「`closeAllConnections()` によるソケット破棄で `stream.write()` が reject → `.catch(cleanup)`」は存在しない。** `node_modules/hono/dist/utils/stream.js` の `StreamingApi.write()` は `try { await this.writer.write(input); } catch { }` と例外を握りつぶして resolve するため、`src/server/routes/sse.ts:84` の `.catch(cleanup)` は決して発火しないデッドコードである。加えて、消費側が pull を止めた場合 `writer.write()` は reject ではなく**永久に pending** になりうるため、「reject するから抜けられる」という前提自体が二重に成り立たない。

**デッドコードの扱い**: `stream.write(...)` 側の `.catch(cleanup)` は **削除**し、「Hono の `StreamingApi.write()` は例外を握りつぶすため reject しない」という事実を 1 行コメントで残す。`client.send` の `stream.writeSSE({...}).catch(cleanup)` は **残す** — `writeSSE` は `event` / `id` / `retry` に `\r\n` が混ざると実際に throw するため、削除すると unhandled rejection になりうる。

走査に載らない client（= フラグ立て後に登録されたもの）は上記の再チェックで keep-alive ループに**入る前に**自己クリーンアップするため、ループ停止の対象にならない。`clients` に取り残されてリークすることも無い。

**`broadcast()` への `shuttingDown` ガードは追加しない。** `shutdown()` が `clients.clear()` するので以後 `broadcast()` は空の `Set` を回るだけの no-op であり、新規 client は 503 / 再チェックで登録されない。フラグ判定を足しても実行結果は変わらないため、コード変更ではなく `shutdown()` の doc コメントに「以後 `broadcast()` は no-op になる」と書いて契約を示す。

### Consequences

- 良い点: レース封じが `sse.ts` の中で完結し、証明が短い（2 つの同期ブロックが interleave しない、で終わる）。しかも証明が Hono の実装詳細に依存しない。
- 良い点: Hono の `app.request` を使った単体テストで決定的に検証できる（実サーバー・実ブラウザ不要）。本 Issue で唯一「対策そのもの」を自動テストできる層。
- トレードオフ: `SseManager.closeAll` → `shutdown` の改名により `src/server/index.ts` と `src/server/routes/sse.test.ts` の呼び出し箇所を追随させる必要がある（いずれもリポジトリ内で完結）。
- トレードオフ: `SseManager` に再起動可能性が無くなる（終端化）。peek はプロセス寿命 = サーバー寿命なので実害は無い。
- トレードオフ: ①と②で返るステータスが異なる（503 / 200 + 即 EOF）。窓が極小かつクライアント挙動が同一なので許容する。
- トレードオフ: `clients` へのリーク防止は「`onAbort` の登録が最初に来ること」に依存したままである（`onAbort` より前に `await` が入ると塞げない）。型やテストでは守れないため、実装のコメントで不変条件として残す。

---

## ADR-004: `in` 演算子ナローイングをそのまま使う（型述語 `isHttpServer` への置き換えは撤回）

### Status
Proposed（当初の Decision をレビューで撤回した ADR。撤回の経緯を残す）

### Context

`shutdown()` の手順 4 に `if ("closeAllConnections" in server) { server.closeAllConnections(); }` がある。CLAUDE.md は「TypeScript の型システムを最大限活用した型安全性」を第一原則に挙げており、リポジトリの他所は判別可能なユニオン（`ServerConfig` / `AppContext` / `Result`）で徹底されている。当初はこの `in` を「方針から外れた数少ない箇所」と見なしたが、**この見立て自体が誤りだった**（Decision を参照）。

型定義を確認した事実:

- `@hono/node-server` の `serve()` の戻り値は `ServerType = http.Server | Http2Server | Http2SecureServer`（`dist/types.d.ts`、`ServerType` は `@hono/node-server` から型として export されている）。
- `closeAllConnections()` / `closeIdleConnections()` は `@types/node` の `http.d.ts`（463, 469 行）にのみ定義があり、`Http2Server` には無い。union のままでは呼べないため、何らかのナローイングが必須。
- peek は `serve({ fetch, hostname, port })` としか呼んでおらず `createServer` / `serverOptions` を渡していないため、実行時は常に `http.Server` である。ただし `serve()` の戻り値型を狭める手段は提供されていない。

選択肢:

- a. 現状維持（インライン `in`）
- b. モジュールスコープの型述語 `isHttpServer(server): server is HttpServer`
- c. `as HttpServer` によるアサーション
- d. `serve()` の代わりに `createAdaptorServer` を使う → 戻り値型は同じ `ServerType` で解決しない

### Decision

**a を採る（現状維持 = インライン `in`）。当初採った b（型述語）は撤回する。**

```ts
// `serve()` returns `ServerType` (http.Server | Http2Server | Http2SecureServer)
// and only `http.Server` has this method, so the union has to be narrowed;
// peek always creates a plain HTTP server.
if ("closeAllConnections" in server) {
  server.closeAllConnections();
}
```

**撤回理由: 型述語は型安全性を上げるのではなく下げるから**。

- `"closeAllConnections" in server` は **TypeScript の制御フロー解析がコンパイラとして検証するナローイング**である。`Http2Server` / `Http2SecureServer` は `@types/node` では `closeAllConnections` を持たない interface なので、`in` は union を `http.Server` に正しく絞り込む。**アサーションはコード上のどこにも存在しない。**
- 対して手書きの `function isHttpServer(s: ServerType): s is HttpServer` は、**本体と述語の整合を TypeScript が検証しない**。`return true;` に書き換えてもコンパイルは通り、実行時に落ちる。つまり「検証済みナローイング → 未検証アサーション」への置き換えであり、CLAUDE.md の「型システムを最大限活用して型安全性を優先する」という第一原則に照らすと**後退**である。
- 当初挙げた利点 (2)（「2 箇所目の利用で再チェックが要らない」）は、**同一 PR の ADR-007 で「打ち切り時の再 `closeAllConnections()`」を撤回した時点で消滅していた**。実際の利用箇所は 1 箇所しかない。利点 (1)（doc コメントの集約）は `in` の直上にコメントを置けば同じく達成できる。残るのは (3)（意図が読める）だけで、それと引き換えに型検査を 1 段落とすのは割に合わない。
- そもそも本件は受け入れ基準から外され「付随整理」に降格していた変更である。**整理のつもりの変更が型安全性を下げるなら、やらない方が正しい。**

なお c（`as HttpServer`）は実行時保証が消えるため引き続き採らない。d（`createAdaptorServer`）は戻り値型が同じ `ServerType` なので解決しない。

**これは本 Issue の要件由来の変更ではなく、`shutdown()` 本体を書き換える際に同じ行を必ず触ることによる付随整理である。** 受け入れ基準には含めない — `in` のままでも `pnpm typecheck` は通るため、変更前後で常に真になる条件しか書けず、基準として何も検証しないからである。撤回の結果、この ADR が生む差分は「なぜナローイングが必要かを説明するコメント 3 行」だけになった。

### Consequences

- 良い点: ナローイングがコンパイラに検証され続ける。型安全性の主張と実際の型検査の向きが一致する。
- 良い点: 差分が最小になり、`shutdown()` から関数 1 つ分の間接が消える。`node:http` / `@hono/node-server` の型 import も不要になった。
- トレードオフ: 「なぜナローイングが必要か」の説明が呼び出し箇所のコメントに置かれる。利用箇所が 1 箇所しかないので集約する必要はない。
- 注記: `in` が false になることは現状あり得ないが、その場合 `closeAllConnections()` がスキップされて `server.close()` が解決しなくなる。ADR-001 のタイムアウトがこのケースも吸収する。

---

## ADR-005: `ServerInstance` を `{ shutdown }` だけに絞る（`close` / `sseCloseAll` / `watcher` を削除）

### Status
Proposed（`watcher` の判断と `timeoutMs` の置き場をレビューで改訂）

### Context

`ServerInstance` は `close` / `watcher` / `sseCloseAll` / `shutdown` を公開している。`grep` の結果、`close` と `sseCloseAll` は `src/` 内のどこからも呼ばれていない（`shutdown()` の内部実装でのみ使用）。テストも `shutdown` しか使っていない。ただし `watcher` フィールドも同様に `src/` 内で外部利用がゼロであり、「未使用だから消す」という基準だけでは `watcher` を残す判断と一貫しない。

### Decision

**削除基準を「未使用**かつ**誤用によって本 Issue のハング（またはそれに準ずる不整合状態）を再現できる」と定義する。** この基準に照らすと:

- **`close`** — 削除する。`close()` だけを呼ぶと「SSE ストリームが生きたまま `server.close()` が待ち続ける」= まさに今回直そうとしているハングを外部から再現できる。
- **`sseCloseAll`** — 削除する。本 Issue で終端操作になるため、`sseCloseAll()` だけを呼ぶと「SSE は死んだがサーバーは生きていて、以後 `/sse` は永久に 503」という不整合な状態を外部から作れる。加えてこの削除は `closeAll` → `shutdown` 改名（ADR-003）の必然的帰結でもある。
- **`watcher`** — **削除する（レビューを受けた改訂）。** 当初は「読み取り専用の観測用フィールドで、これ単体を触ってもライフサイクルの不整合は作れない」として残す判断だったが、これは基準の後半を過小に読んでいた。`FileWatcherHandle.close()` は公開されており、`server.watcher.close()` を単独で呼ぶと **HTTP サーバーと SSE ストリームは生きたままファイル監視だけが死に、ブラウザは接続を保ったまま永遠に更新を受け取らない**。これは `sseCloseAll` の削除理由に挙げた「SSE は死んだがサーバーは生きている」と同型であり、基準の「またはそれに準ずる不整合状態」に該当する。加えて `grep -rn "\.watcher\|watcher:" src` の結果、**参照は宣言行のみ**（テストからも使われていない）で `close` / `sseCloseAll` と条件が完全に一致する。同じ PR で 2 つを消しながらこれだけ残す理由は無い。

```ts
export type ServerInstance = {
  readonly shutdown: () => Promise<void>;
};
```

- シャットダウンは「全部落とすか、何もしないか」の 2 択にする。
- **タイムアウト値の注入口は `shutdown()` の引数ではなく `startServer()` の第 2 引数に置く** — 詳細は ADR-008。当初は `shutdown(options?: { timeoutMs })` としていたが、memo 化との契約矛盾を型で消せるため撤回した。
- タイムアウト時はソケットハンドルが残りうること（プロセス終了の責務は呼び出し側）は引き続き `shutdown` の doc コメントに明記する。

**破壊的変更に見えるが実際には非破壊**である。package.json には `main` / `exports` が無く `bin` のみなので、この型を import できる外部コンシューマは存在しない。

**位置づけ**: 本 ADR は Issue の受け入れ基準そのものではなく、再発防止の付随整理である（ADR-004 と同じカテゴリ）。plan.md のスコープ「含まれるもの（付随整理）」に明記し、PR 説明にも書く。

### Consequences

- 良い点: 誤用してハングや不整合を再現できる経路が型レベルで消える。ライフサイクル管理の責務が `shutdown()` 一点に集約される。
- 良い点: 削除基準が 3 フィールドすべてに同じ結論で適用され、一貫性が実際に担保された。`ServerInstance` はメソッド 1 つの型になった。
- トレードオフ: 将来「SSE だけ落として再起動する」「watcher の状態を観測する」ような要求が出たら再度 API を生やす必要がある。現状そのユースケースは存在せず、peek はプロセス寿命 = サーバー寿命なので発生する見込みも薄い。
- 注記: `watcher` フィールドの削除は `startServer` の内部（`setupWatcher()` の戻り値を `shutdown()` のクロージャが握る形）には影響しない。`src/index.ts` も `server.watcher` を使っていないため CLI 側の変更は不要だった。

---

## ADR-006: keep-alive の待機を手書き `sleep()` から `node:timers/promises` に置き換える

### Status
Proposed

### Context

`src/server/routes/sse.ts:9-21` の `sleep()` は次のように実装されている。

```ts
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
```

`{ once: true }` は「**発火したら**外す」オプションであり、「解決したら外す」ではない。したがって **`setTimeout` が先に解決した（= 正常完了した）場合、abort リスナーは `AbortSignal` に残り続ける**。

実測（`node:events` の `getEventListeners` で確認。**本計画で再現済み**）:

| 実装 | 25 回正常完了後の `abort` リスナー数 |
|---|---|
| 現行の手書き `sleep()` | **25** |
| `node:timers/promises` の `setTimeout` | **0** |

あわせて、既に abort 済みの signal を渡した場合の挙動も測定した: `node:timers/promises` は **0ms で `AbortError` を reject する**のに対し、手書き `sleep()` は `addEventListener("abort")` が発火済み signal では呼ばれないため **30 秒待ち切る**。現行コードにこの到達経路は無いが、標準 API 化は堅牢性の面でも改善になる。

keep-alive は 30 秒周期なので、SSE クライアント 1 本あたり**毎時 120 個**のリスナーとクロージャが `abortController.signal` に蓄積する。これは本 Issue の調査で**実測できた唯一の欠陥**であり、「ブラウザのプレビュータブを開いたままにしているほど踏みやすい」という Issue の症状プロファイルと一致する唯一の事象でもある。

ただし、リスナーの蓄積そのものが `server.close()` を止める機序は見つかっていない（`abort()` は数千個でも同期で一瞬で流れる）。

### Decision

**手書きの `sleep()` を削除し、Node 標準の中断可能タイマーに置き換える。**

```ts
import { setTimeout as delay } from "node:timers/promises";
// ...
try {
  await delay(KEEP_ALIVE_INTERVAL_MS, undefined, { signal: abortController.signal });
} catch {
  break;  // abort で中断された — 期待どおり
}
```

**本 Issue のスコープに含める理由**（要件外だが妥当と判断）:

1. 変更対象そのもの（`sse.ts` の keep-alive ループ）の中にある欠陥であり、同一関数群を改修中である。
2. Issue の症状プロファイルと一致する唯一の実測欠陥である。真因未特定の状況で、実測できた欠陥を残したまま閉じるのは合理的でない。
3. 差分が小さい（ヘルパ 1 つの削除と 1 行の置換）。挙動は abort 時・正常完了時とも等価。

**検証方法（計画段階で作り直し、さらに穴を 2 つ塞いだ）**

当初の計画は「`node:timers/promises` の `setTimeout` を N 回正常完了させ、リスナー数が 0 のままであることを assert する」としていたが、これは `sse.ts` を 1 行も通らず、実装が手書き `sleep()` に戻っても緑のままだった（レビューの指摘どおり）。そこで `createSseManager()` を実際に経由する形に作り直し、さらに次の 2 点を足した。

- vitest の fake timers で `/sse` ハンドラを駆動し、`globalThis.AbortController` をサブクラスでスパイして client の `signal` を捕捉する。捕捉した全 signal の `getEventListeners(s, "abort").length` の**最大値が 1 以下**であることを assert する（`signals` には Hono 内部の `AbortController` も混ざるため添字決め打ちにしない）。
- **レスポンス body をバックグラウンドで読み捨てる。** これをしないと Hono の `TransformStream` が書き込みを 1 件だけバッファしてバックプレッシャーでループが止まり、リークが線形増加として現れない。
- **positive control を置く**（`expect(signals.length).toBeGreaterThan(0)` / `expect(sse.clientCount).toBe(1)` / `expect(counts).toContain(1)`）。`counts` には Hono 内部の signal（リスナー 0 個）が必ず混ざるため、これが無いと **`/sse` ハンドラが keep-alive 待機に到達しない実装で `counts = [0, 0]` → `max = 0` となり無検証のまま緑になる**（vacuous pass）。しかもその状態を作る変更（②の再チェック）は同じ改修に含まれている。
- **`finally` で `sse.shutdown()` を呼ぶ**。`delay()` は既定 `ref: true` かつ fake timers に駆動されないため、テスト中に張られた 30 秒タイマーが実タイマーとして残る。

本計画で 4 実装 × body 読み捨ての有無 × 8 tick を実測した:

| 実装 | body を読まない | **body を読み捨てる（採用形）** |
|---|---|---|
| (a) `node:timers/promises` 版 | `[1,1,1,1,1,1,1,1]` | `[1,1,1,1,1,1,1,1]` → pass |
| (b) 手書き `sleep()`（リークあり） | `[2,2,2,2,2,2,2,2]` | **`[2,3,4,5,6,7,8,9]`** → fail |
| (c) keep-alive 待機に到達しない | `[0,0,0,0,0,0,0,0]` | `[0,0,0,0,0,0,0,0]`（`clientCount = 0`）→ fail |
| (d) 手書きだがリーク修正済み（fake timers に駆動される） | `[1,0,0,0,0,0,0,0]` | `[1,1,1,1,1,1,1,1]` → pass |

**このテストが証明する範囲（重要）**: (a) が pass するのは「fake timers が `node:timers/promises` を駆動しないため、ループが最初の待機で止まったままリスナーが 1 個」だからである（下記トレードオフ）。つまりこのテストは **手書き `sleep()`（グローバル `setTimeout` ベース）の再導入と、ハンドラが待機に到達しない実装の 2 方向を検出する回帰ガード**であって、(a) について「N 回正常完了してもリークしない」ことの証明ではない。後者は本 ADR に記録した直接実測（25 → 0）で担保する。この限界を plan.md の AC-8 直下・ステップ 7・テスト方針に明記した。

一方、body 読み捨てを入れたことで **判別が fake timers の非対称性に依存しなくなった**点は重要である。上表 (d) のとおり fake timers に駆動される正しい実装でも通るため、このテストが見ているのは「実装がどちらのタイマー API か」ではなく「**client 1 本あたりの abort リスナーが 1 個を超えないか**」という性質そのものである。

### Consequences

- 良い点: リークが構造的に消え、`sse.ts` から手書きヘルパ自体が不要になる（コード量も減る）。
- 良い点: Node 標準 API に寄せることで、abort 時の reject（`AbortError`）と `clearTimeout` の扱いが実装依存でなくなる。既に abort 済みの signal でも即 reject する（手書き版は待ち切る）。
- トレードオフ: **vitest の fake timers は `node:timers/promises` を差し替えない**（本計画で実測確認: `vi.advanceTimersByTimeAsync(30_000)` を繰り返しても `delay(30_000)` は解決しない。グローバル `setTimeout` は解決する）。したがって置き換え後は keep-alive ループをフェイクタイマーで進められなくなる。将来 keep-alive の周期挙動そのものをテストしたくなったら `createSseManager()` に間隔の注入口を開ける必要がある。本 Issue にその要求は無く、注入口を開けるのは要件と無関係な API 拡張なのでスコープ外とする。**なお当初は「この非対称性を AC-8 の回帰ガードとして転用する」としていたが、body 読み捨てを入れたことで依存は外れた**（上表 (d) のとおり fake timers に駆動される実装でも通る）。したがって将来 vitest が `node:timers/promises` を駆動するようになっても AC-8 が false-red になることはない。
- トレードオフ: リークが本 Issue のハングの原因である保証は無い（機序が見つかっていない）。したがって本変更は「要件充足」ではなく「実測欠陥の解消」として位置づける。ADR-001 の主従関係は変わらない。
- 注記: `delay()` の第 3 引数は既定で `ref: true` なので、現行の `setTimeout` と同じくイベントループを保持する。keep-alive の意味論は変わらない。
- 注記: 手書き版は `reject(signal.reason)` でカスタム reason を透過するが、`node:timers/promises` は常に汎用 `AbortError` を投げる。`catch { break }` が reason を見ないため影響なし。

---

## ADR-007: 観測性のための追加は「シグナル受信ログ 1 行」に留める（stdio drain と打ち切り時の再 `closeAllConnections()` は採用しない）

### Status
Proposed（当初の Decision を一部撤回した ADR。撤回の経緯を残す）

### Context

ADR-001 で「タイムアウト発火時の `logger.warn` が真因切り分けの唯一の手掛かり」と位置づけたことから、レビューで 3 点の対策が提案され、いずれも計画に取り込んだ。

1. **警告ログが `process.exit(0)` で取りこぼされうる** → `process.exit(0)` の直前に stdout / stderr を drain する（`withTimeout(..., 200)` で有界化）。
2. **タイムアウトで打ち切ると `server.close()` のコールバック未発火のまま resolve する** → 打ち切り時に `closeAllConnections()` を再度呼ぶ。
3. **「そもそも SIGINT ハンドラが起動していなかった」可能性を排除できていない** → シグナル受信ログを出す。

その後 (1) と (2) に反証が出たため、実測して確認したうえで方針を改める。

### Decision

**(1) stdio drain は採用しない（当初の決定を撤回する）。**

理由は 2 つで、いずれも実測に基づく。

- **drain は AC-1（exit code 0）を壊す。** `process.stdout` / `process.stderr` が pipe で読み手が既に消えている状態で書き込むと、Node は**非同期に `'error'` イベントを emit する**。現行コードは書き込み直後に `process.exit(0)` するためイベント配送前にプロセスが消えるが、drain を `await` するとイベントループが 1 周して `'error'` が配送され、既定ハンドラが無いので uncaught exception になる。peek の shutdown ハンドラと同形（SIGINT → 3 行書き込み → drain → `process.exit(0)`）のスクリプトで実測: **drain 無し → exit code 0 / drain 有り → exit code 1。** しかも壊れるのは机上の状況ではなく、**AC-3 の警告を採取するために計画が指定していた `peek . 2>&1 | tee log` そのもの**である（Ctrl+C はフォアグラウンドプロセスグループ全体に届くので `tee` が先に死ぬ）。`peek . | head`、ページャで途中離脱、CI のログ収集プロセスが先に落ちる、も同じ経路。
- **そもそも救う場面がほぼ無い。** 短い 1 行（`[peek] WARN ...` 相当）は pipe 越しでも `process.exit(0)` の直前に書けば欠落しないことを実測した。欠落するのは**未 flush 出力が 64KB を超える場合のみ**（stderr に 200KB 書いて即 `process.exit(0)` した場合、pipe では 65536 バイトで切れ、**ファイルリダイレクトでは全量 200025 バイトが残った**）。peek のシャットダウン経路が出力するのは数行なので該当しない。

drain を残す選択肢（`process.stdout.on("error", () => {})` / `process.stderr.on("error", () => {})` を先に登録して EPIPE を握りつぶす）も検討したが、**要件充足に寄与しない観測性強化のために、終了パスに `await` とグローバルなエラーハンドラ登録を追加する費用対効果が見合わない**ため採らない。代わりに **`logger.warn` を `process.exit(0)` より前に呼ぶ順序を保つ**だけにとどめ、「将来シャットダウン経路に大量出力を足すと警告が欠落しうる」という残存リスクを plan.md の「リスクと注意点」に実測値付きで記載する。

なお当初の記述「stderr が TTY でない場合は非同期になる」は一般化しすぎだったので撤回する。Node の stdio が同期か非同期かは接続先と OS で決まり、**ファイルは同期、TTY は POSIX で同期、pipe は macOS でのみ非同期**である。上記の実測（ファイルリダイレクトでは 200KB 全量が残る）とも一致する。

**(2) 打ち切り時の再 `closeAllConnections()` は採用しない（当初の決定を撤回する）。**

呼び出し自体が安全であることは確認されている（2 回連続でも、`close()` のコールバック発火後でも throw しない）。しかし**効く場面が構成上存在しない**: ADR-002 の手順 1 でリスニングハンドルを閉じているため手順 4 以降に新規ソケットが accept されることはなく、手順 4 で destroy 済みのソケットへの再 destroy は no-op である。「打ち切りの原因が destroy し切れていないソケットである場合に効く」という当初の根拠は、その状態が `destroy()` の再呼び出しで解消する保証が無いため成立しない。**無害でも実効ゼロの処理を「保険」として残すと将来の読者を誤らせる**ので削除する。

一方、`ServerInstance.shutdown` の doc コメントに「タイムアウト時はソケットハンドルが残りうる。プロセスを終わらせる責務は呼び出し側（CLI）にある」と明記する方針は**維持する** — 追加処理で解消できない以上、契約として書き残すことに価値がある。

なお **ポート自体はリスニングハンドルを閉じた時点（ADR-002 の手順 1）で解放される**。`server.close()` を呼んだ直後、コールバック未発火の状態で同じポートに再 bind できることを実測確認済みなので、テストのポート衝突は起きない。`src/server/index.test.ts` の `afterEach`（`await server?.shutdown().catch(() => {})`）は変更不要で、むしろ `shutdown()` が有界になったことで teardown が無限に待つ可能性が消える。

**(3) CLI のシグナルハンドラで受信シグナル名をログに出す（採用。挿入位置のみ変更）。**

`process.on("SIGINT", handler)` はハンドラ第 1 引数にシグナル名を渡す。ハンドラを `async (signal: NodeJS.Signals) => { ... }` にし、`logger.info(\`Received ${signal}, shutting down...\`)` を 1 行出す。

**挿入位置は既存の `console.log()`（空行）の後・`intro(...)` の前**とする。当初の「force exit 判定の直後」だと `console.log()` より前になり、実端末では `^C` のエコーと同じ行に `^C[peek] Received SIGINT, shutting down...` と連結して表示されてしまう。既存コードが `console.log()` で `^C` と `intro()` を分離している意図を壊さないため、位置を後ろにずらす。clack のバー描画（`intro` 〜 `outro` の枠）も壊さない。

この 1 行の増分価値は「どのシグナルで起動したか」の識別に限られる（既存の `intro(" Shutting down... ")` の表示有無だけでも (i)/(ii) の切り分けは可能）。それでも残すのは、Issue の観測「SIGTERM では即座に終了した」の解釈に SIGINT / SIGTERM の区別が直接効くためである。真因が判明したら削除を検討する。

### Consequences

- 良い点: 終了パスに `await` を一切追加しないため、AC-1（exit code 0 / 5 秒以内）に対する新たなリスクを持ち込まない。**「直すために入れた変更が新しいバグを生む」経路を計画から消した。**
- 良い点: 「SIGINT ハンドラが起動したのか」という真因の有力候補を次回再発時に判別できる。真因未特定の状況ではこの観測手段が要件充足と同等に重要である。
- 良い点: 実効ゼロの後始末が消え、シャットダウン手順が「順序に意味のある 5 ステップ」だけになる。
- トレードオフ: 未 flush 出力が 64KB を超える状況では警告が欠落しうる（現状のシャットダウン経路では起きない）。残存リスクとして plan.md に記載する。
- トレードオフ: タイムアウト時に残ったソケットハンドルは回収されないままプロセス終了に委ねられる。peek は CLI であり `process.exit(0)` が続くため実害は無いが、テストから予算ゼロで起動した（`startServer(config, { shutdownTimeoutMs: 0 })`、ADR-008）サーバーを落とすケース（AC-3）では未決着の `closing` が残る。doc コメントで契約として示す。
- トレードオフ: CLI に「変更なし」ではなくなる。ただし追加は 1 行のみで、プロセス制御の構造（`process.exit` が CLI 層の単独責務）は変えない。
- トレードオフ: 通常終了時にも `Received SIGINT, shutting down...` が 1 行増える。真因未特定の間は許容する。

---

## ADR-008: シャットダウン予算は `shutdown()` の引数ではなく `startServer()` のオプションにする

### Status
Proposed（レビューを受けた新規判断。ADR-005 の該当箇所を置き換える）

### Context

ADR-005 は AC-3（タイムアウト分岐を決定的にテストする）のために `shutdown(options?: { readonly timeoutMs?: number })` を定義した。しかし `shutdown()` は memo 化されており「最初の呼び出しが勝つ」。この 2 つは同居できない — `shutdown({ timeoutMs: 5000 })` を 2 回目に書いた読者は必ず間違える。ADR-005 自身が「直感に反する挙動が生まれる。doc コメントで明記して緩和する」と認めていたが、**緩和は解消ではない**。

加えてこの引数の唯一の利用者は `src/server/index.test.ts` であり、プロダクション経路（`src/index.ts`）は常に既定値を使う。つまり**テスト注入のためだけにプロダクション API を広げた**形になっていた。

選択肢:

- a. 現状維持（`shutdown(options)` + doc コメントで注意書き）
- b. `startServer(config, options?: { readonly shutdownTimeoutMs?: number })` に移し、`shutdown` は `() => Promise<void>` に戻す
- c. `ServerConfig` にフィールドを足す
- d. 注入をやめ、タイムアウト分岐のテストを `withTimeout` の単体テストだけに任せる

### Decision

**b を採る。**

```ts
export type StartServerOptions = {
  readonly shutdownTimeoutMs?: number;
};

export async function startServer(
  config: ServerConfig,
  options?: StartServerOptions,
): Promise<ServerInstance>;
```

- 予算は**インスタンスの寿命に対して 1 回だけ決まる値**である。生成時に受け取れば、memo 化との矛盾が**型のレベルで**消える（「2 回目以降は無視される引数」がそもそも存在しなくなる）。
- `ServerInstance.shutdown` は `() => Promise<void>` に戻る。ライフサイクル操作としての契約（冪等・有界・プロセス終了は呼び出し側の責務）だけが残る。
- 既定値の解決は `options?.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS` を `startServer()` の冒頭で 1 回行う。`{ shutdownTimeoutMs: undefined }` が予算ゼロ（ADR-001 の `!(timeoutMs > 0)`）に落ちない点は当初の設計から変わらない。
- c（`ServerConfig` にフィールドを足す）は採らない。`ServerConfig` は 3 分岐の判別可能ユニオンなので、全分岐に同じフィールドを足すことになり差分が大きい。第 2 引数なら差分は最小で、config（何を配信するか）と options（どう運用するか）の分離も自然である。
- d（注入をやめる）は採らない。AC-3 は `shutdown()` 側の警告出力までを検証対象にしており、`withTimeout` の単体テストではそこに届かない。

`src/server/index.test.ts` の「warns when the server does not close within the budget」は `startServer({ ...baseConfig, port }, { shutdownTimeoutMs: 0 })` + 引数なしの `shutdown()` に書き換える。決定性は変わらない（予算ゼロの意味論は ADR-001 のまま）。

### Consequences

- 良い点: 「memo 化された関数が毎回引数を受け取る」という契約矛盾が構造的に消え、doc コメントでの謝罪が不要になった。
- 良い点: `ServerInstance` が「引数なしのメソッド 1 つ」になり、ハンドル型として最小になった（ADR-005）。
- 良い点: 予算が「1 回だけ決まる値」であることが型で表現され、CLAUDE.md の型安全性原則に沿う。
- トレードオフ: 予算を変えたい呼び出し側は `startServer()` の時点で決める必要がある。プロダクションは既定値のみ、テストは生成時に決められるので実害は無い。
- トレードオフ: `startServer` に第 2 引数が増える（プロダクション経路の `src/index.ts` は省略するので変更不要）。

---

## ADR-009: `shutdown()` の再入ガードを手順の同期性から独立させる

### Status
Proposed（レビューを受けた新規判断）

### Context

当初の実装は次の形だった。

```ts
shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => { /* 手順 1〜4 */ await withTimeout(...); })();
  return shutdownPromise;
}
```

`shutdownPromise = (async () => {...})()` は、**右辺の IIFE 本体が最初の `await` に到達するまで同期実行され、代入はその後に完了する**。つまり手順 1〜4 の実行中は `shutdownPromise` が `undefined` のままで、その窓で `shutdown()` が再入すると `if (shutdownPromise)` を素通りし、手順が二重に走って 2 本目の `shutdownPromise` が生まれる。

今日は到達しない（手順 1〜4 はどれも同期的に外部コードへ制御を渡さない: `abortController.abort()` の同期リスナーは `delay` 内部のもの、`socket.destroy()` の `'close'` は nextTick、`FSWatcher.close()` の `'close'` も nextTick）。しかし **「同期実行だから安全」はこの PR がまさに消そうとしている依存**であり（ADR-001）、`shutdown()` 本体に同じ基準を適用しないのは一貫性を欠く。

対策の候補:

- a. 現状維持 + 「手順 1〜4 は同期的に外部へ制御を渡さないこと」を不変条件としてコメントに書く
- b. `shutdownPromise = Promise.resolve().then(run)` — **AC-4 を壊すので不可**（最初の `await` の前にリスナーが閉じている、という契約が崩れる）
- c. `let started = false` を先に立てる — ガードは効くが、再入した呼び出しに**返す promise が無い**
- d. deferred（`Promise.withResolvers()`）を先に作って memo に入れ、その後で本体を走らせる

### Decision

**d を採る。**

```ts
shutdown() {
  if (shutdownPromise) return shutdownPromise;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  shutdownPromise = promise;
  runShutdown().then(resolve, reject);
  return promise;
}
```

- `Promise.withResolvers()` の executor は同期実行されるので、**`shutdownPromise` への代入は `runShutdown()` の呼び出しより前に完了する**。手順 1〜4 の途中で再入しても、必ず同じ promise が返る。実測で確認した（同形のスクリプトで、手順の先頭時点において memo が既に設定済みであること）。
- `runShutdown()` は依然として最初の `await`（＝ `withTimeout`）まで同期実行されるため、**AC-4（`shutdown()` から戻った時点でリスナーは閉じている）は保たれる**。b と違ってここが崩れない。
- c と違い、再入した呼び出しにも正しい promise を返せる。
- a（コメントで不変条件を書くだけ）は、守らせる手段がレビュアーの目しかないので採らない。
- `Promise.withResolvers` は Node 22+ / ES2024 で利用でき、`tsconfig.json` の `target` / `lib` はいずれも `ES2024`、`engines` は `>=22.0.0` なので追加の前提は不要。

### Consequences

- 良い点: 再入ガードの正しさが「手順が同期であること」から独立した。将来手順に `await` やコールバックが入っても冪等性が壊れない。
- 良い点: 手順本体が `runShutdown()` という名前付きの関数に出たことで、`shutdown()` 側は「memo とガード」だけを読めばよくなった。
- トレードオフ: deferred を経由するぶん promise が 1 本増える。シャットダウンは 1 プロセスにつき 1 回なのでコストは無視できる。
- トレードオフ: 「なぜ `shutdownPromise = runShutdown()` と書かないのか」が自明でないため、コメントで理由を残す必要がある（残した）。

---
