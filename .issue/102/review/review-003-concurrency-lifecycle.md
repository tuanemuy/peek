# Concurrency & Lifecycle Review #003

**Date:** 2026-07-25
**Round:** 3回目
**対象:** PR #116 (`issue/102/fix-shutdown-hang` @ `5a44ecd`) / 2 ラウンド目の対象は `b8e5da3`

---

## Summary

- Blockers: 0
- Warnings: 0
- Notes: 5
- Verdict: **APPROVED**

2 ラウンド目の指摘 2 件はどちらも解消されており、その修正が持ち込んだ新しいハング経路・レース・情報損失・リソースリークは**検出できなかった**。`step(run)` による手順ごとの個別捕捉は「どの手順が失敗しても手順 5 の有界待機に必ず到達する」を実際に達成しており（フォールト注入 6 パターンで実測）、`AggregateError` は実 CLI の `logger.error` で全ての原因が読める形で出力される。`if (!closed) clients.add(client)` は 2 ラウンド目に指摘したリーク窓を実際に塞いでいる（窓を人工的に開けた対照実験で確認）。以下は全て Note であり、マージを止めるものはない。

---

## 検証方法（この結論の根拠）

`5a44ecd` を **detached worktree**（`scratchpad/wt-conc-r3`）にチェックアウトして検証した。**メインの作業ツリーのソースは一切変更していない**（本ファイルの書き込みを除く）。作業後 worktree は `git worktree remove` 済み。Node v22.22.1 / macOS。

| # | 検証内容 | 結果 |
|---|---|---|
| V-1 | `vitest run` / `tsgo` / `biome check src` | **271 tests pass**（clean で 11 回連続 pass、フレーク無し）、typecheck 0、lint 0 |
| V-2 | engines 下限 `node@22.0.0` で `AggregateError` / `Promise.withResolvers` | `v22.0.0 function function`。`lib: ES2024` で型も通る |
| V-3 | 実 CLI + 実 SIGINT（無注入、SSE 1 本接続） | exit 0 / **11ms** |
| V-4 | 実 CLI + 手順 2 に throw 注入（失敗 1 件） | exit 0 / **8ms**、`Failed to shut down server: Error: injected sse.shutdown failure`（**素の Error**、警告なし）。R2 では同条件で 2024ms + 誤警告だった |
| V-5 | 実 CLI + 手順 2 と手順 4 に throw 注入（失敗 2 件） | exit 0 / **2027ms**、warn 1 件 + `AggregateError` に **両方のスタック付きエラー**が展開表示 |
| V-6 | 実 CLI + 手順 2/3/4 全てに throw 注入（失敗 3 件） | exit 0 / **2010ms**、`AggregateError.errors` に 3 件すべて |
| V-7 | 実 CLI + `close()` が予算内に**同期 reject** + 手順 2 throw | exit 0 / **15ms**、`AggregateError`（sse + close）、**タイムアウト警告なし**、unhandled rejection 0 |
| V-8 | 実 CLI + `close()` が予算内に同期 reject のみ | exit 0 / **16ms**、素の `Error: injected close failure`、警告なし |
| V-9 | 実 CLI + `close()` が**永久に解決しない** | exit 0 / **2011ms**（SSE 有り）・**2024ms**（SSE 無し）、warn 1 件 |
| V-10 | 実 CLI + SIGINT 2 回（hang 注入下） | exit **1** / 306ms、`Force exiting...` |
| V-11 | 実 CLI + **SIGTERM** + 失敗 2 件注入 | exit 0 / 2030ms、`AggregateError` 展開表示 |
| V-12 | AC-4: `shutdown()` 解決直後に生 TCP connect（無注入 + 5 種のフォールト注入） | **全 6 パターンで `ECONNREFUSED`**。同時に `shutdown()` の memo（`p1 === p2`）も全パターンで `true` |
| V-13 | 失敗件数と throw の型（in-process） | 0 件→resolved / 1 件→`Error` / 2 件以上→`AggregateError`。全パターンで unhandled rejection 0 |
| V-14 | `withTimeout`: 予算後の reject / 予算ゼロでの reject | どちらも unhandled rejection 0（プロセスを生かしたまま 400ms 観測） |
| V-15 | **SSE の窓を人工的に開けた対照実験**（`onAbort` と `clients.add` の間に `await 80ms` を注入し、窓の中で abort / `sse.shutdown()` / 両方を発火） | 下表 |
| V-16 | keep-alive ループの計装（`KEEP_ALIVE_INTERVAL_MS`=120ms + tick ログ）| 健全な接続では `LOOP ENTERED` + 9 tick（陽性対照）。窓の中で abort した場合は**ループに一度も入らない** |
| V-17 | Hono `StreamingApi` 実装の確認 | `abort()` は `aborted` をラッチし、その時点の `abortSubscribers` のみ発火。**後から `onAbort()` しても発火しない**（コメントの主張と一致） |
| V-18 | ミューテーション 5 種 × 各 2 回 | 下表 |

**V-15（`clients` リーク窓の対照実験、`clientCount` を計測）:**

| 実装 | 窓の中で abort | 窓の中で `sse.shutdown()` | 窓の中で両方 |
|---|---|---|---|
| `if (!closed) clients.add(client)`（本 PR） | **0** | 0 | **0** |
| ガードを外した対照（R2 時点） | **1（永久にリーク）** | 0 | **1（永久にリーク）** |

**V-18（ミューテーションテスト、全 271 件に対して）:**

| ミューテーション | 検出 |
|---|---|
| `step()` の try/catch を外し `run()` を直呼び | ✅ 3 件失敗（`shutdown error isolation` の 3 ケース全部） |
| 手順 5 の `catch` で `failures.push` をやめる | ✅ 1 件失敗（`collects a rejection from the bounded wait…`） |
| `failures.length === 1` の素通し分岐を削り常に `AggregateError` | ✅ 1 件失敗（`runs the later steps and the bounded wait…`） |
| `if (!closed)` ガードを外す | ❌ 検出されず（N-004） |
| `onAbort` を `clients.add` の**後**に戻す | ❌ 検出されず（N-004） |

---

## 2ラウンド目指摘の解消状況

- **[W-001] `if (!closed) clients.add(client)` によるリーク窓の封鎖** — **解消**。`src/server/routes/sse.ts:81-83`。V-15 の対照実験で、窓を人工的に開けた状態でも `clientCount` が 0 に戻ることを実測した（ガードを外した対照は 1 のまま永久に残る）。あわせてコメント（75-79 行）も事実どおりの記述（「`abort()` は登録済みリスナーにしか通知せず `aborted` をラッチするので後からの `onAbort()` は発火しない → だから publish は cleanup 済みならスキップする」）に書き換わっており、V-17 で Hono の実装と一致することを確認した。ADR-003 側の記述も更新されている。
- **[W-002] エラー分離の粒度（手順 2 の throw が手順 4 を巻き添えにする）** — **解消**。`src/server/index.ts:219-246` で手順 2 / 3 / 4 が `step(run)` により**個別に**捕捉される。R2 で 2024ms（+ 誤ったタイムアウト警告）だった「SSE 接続あり + 手順 2 throw」の実 CLI シナリオが、本ラウンドでは **8ms・警告なし**になった（V-4）。手順 4 が独立して走るようになったことが直接の理由で、指摘の趣旨どおりの修正になっている。

---

### Concurrency & Lifecycle

#### Blockers

なし。

#### Warnings

なし。

#### Notes

- **[N-001]** **`step(run)` の型 `(run: () => void)` は async コールバックを黙って受け入れる。** 実際に `step(() => someAsyncFn())` を書いて `pnpm typecheck` を通したところ **0 error** だった（TS の void-returning assignability）。今日の 3 手順（`sse.shutdown()` / `watcher.close()` / `closeAllConnections()`）はいずれも `() => void` なので到達しないが、将来どれかが async 化されると (a) `runShutdown()` はその完了を待たず、(b) 失敗は `failures` に載らず unhandled rejection になり、(c) `step()` が謳う「どの手順が失敗しても失われない」が静かに崩れる。「同期だからたまたま安全」を消すのがこの PR の主題である以上、`step` の引数型を `() => void` のまま**意図的に**選んだのか（＝async 手順は設計上あり得ないのか）を 1 行のコメントで固定しておく価値はある。実装変更を求めるものではない。

- **[N-002]** **手順 5 の try/catch と警告の関係は正しい。** `outcome` は `try` ブロック内の `const` なので、`withTimeout` が reject した場合に「`outcome` が未定義のまま後続処理へ進む」経路は構文上存在しない。「予算内に reject したときに警告を出さない」も意味論として正しく（閉じられなかったのではなく、閉じた結果がエラーだった）、その失敗は `failures` 経由で必ず CLI に届く（V-7 / V-8 で実測）。ただし**予算が切れた後に `closing` が reject する**ケースだけは、警告は出るが reject の中身は `withTimeout` の仕様どおり破棄され、原因はどこにも残らない（`with-timeout.ts:16-19` の doc と ADR-001 が明示的に許容している既知のトレードオフ）。unhandled rejection にはならないことを V-14 で再確認した。

- **[N-003]** **手順 1 の `const closing = close();` が `step()` で包まれていないのは正しい。** `close()` の本体は `new Promise(executor)` であり、`server.close()` が executor 内で throw しても Promise コンストラクタが**同期 throw を reject に変換する**ため、`close()` が同期 throw する経路は存在しない。したがって「手順 1 が throw して手順 2〜5 が全部飛ぶ」経路は無い。さらに `close()` から `withTimeout(closing, …)` までの間に `await` が 1 つも無いため、`closing` が同期 reject しても同一ティック内で `withTimeout` がハンドラを張り、unhandled rejection にならない（V-7 の同期 reject 注入で実測）。

- **[N-004]** **SSE 側の 2 つの不変条件（`if (!closed)` ガードと `onAbort` の登録順序）には回帰ガードが無い。** V-18 のとおり、どちらを潰しても 271 件全 PASS する。順序を元に戻すと「窓が開いた場合に client が `clients` に残り、かつ `closed` が false のまま keep-alive ループが 30 秒周期で回り続ける」という、ガードありの現状より**厳密に悪い**状態になるので、不変条件としては本物である。一方でこの窓は今日のコードには存在しない（`onAbort` と `clients.add` の間に `await` が無い）ため、テストで固定するには `sse.ts` 自体に人工的な `await` を挿す必要があり、R1 台帳が同種の項目に与えた「best effort、不可能なら wont-fix」の判断がそのまま当てはまる。**コメント（`sse.ts:75-79`, `85-89`）が唯一の防御である**ことを認識した上で APPROVED としている。

- **[N-005]** **`AggregateError` の到達可能性は実質ゼロ。** 2 件以上の失敗が同時に起きるには、`sse.shutdown()` / `watcher.close()` / `closeAllConnections()` のうち 2 つ以上、あるいはそのうち 1 つと `server.close()` のコールバックエラーが同時に発生する必要がある。今日 throw しうる箇所は無い（`cleanup()` の `abortController.abort()` はリスナー例外を呼び出し元へ伝播しない、`FSWatcher.close()` は同期 no-op、`closeAllConnections()` は `kConnections` の走査のみ）。ADR-002 もこの点を「現状のコードでは到達しない」と明記しており、`AggregateError` は**予防的な語彙**である。導入コストが型定義ゼロ・失敗 1 件時の既存挙動が完全維持（V-4 / V-8）であることを踏まえれば妥当な選択だと判断した。

---

## `AggregateError` が CLI に届いたときの追跡可能性（実 CLI での検証）

`logger.error` は `console.error(PREFIX, ...args)` であり、Node の `util.inspect` が `AggregateError` を **`[errors]` プロパティとして展開し、内側の各 Error をスタックトレース付きで表示する**（デフォルト深さ 2 に収まる）。実 CLI + 実 SIGINT + 手順 2/4 への throw 注入（V-5）での実出力:

```
[peek] HTTP server did not close within 2000ms — giving up and leaving the remaining sockets to the caller.
[peek] Failed to shut down server: AggregateError: Failed to shut down the server.
    at runShutdown (…/src/server/index.ts:260:13)
    at async process.shutdown (…/src/index.ts:185:9) {
  [errors]: [
    Error: injected sse.shutdown failure
        at <anonymous> (…/src/server/index.ts:233:24)
        at step (…/src/server/index.ts:221:9)
        …
    Error: injected closeAllConnections failure
        at <anonymous> (…/src/server/index.ts:242:24)
        at step (…/src/server/index.ts:221:9)
        …
  ]
}
```

3 件注入した場合も 3 件すべてが展開された（V-6）。**ユーザーは原因を追える**。失敗が 1 件のときは `AggregateError` で包まれず素の `Error` がそのまま出るため、既存の見た目・既存契約は完全に維持されている（V-4 / V-8）。

---

## 受け入れ基準の判定（担当観点分）

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1（必ず終了する） | ✅ | SIGINT/SIGTERM × フォールト 6 種 × 実 CLI で**全て exit 0**（V-3〜V-9, V-11）。`runShutdown()` の唯一の待機点は `withTimeout` であり、タイマーは `unref()` されていないので必ず発火する。`AggregateError` が throw される経路も `src/index.ts:186-188` の `catch` に入り `process.exit(0)` に到達する（V-5 / V-6 / V-11 で実測）。2 回目 SIGINT の force exit（exit 1）も健在（V-10） |
| AC-2（有界） | ✅ | `close()` 永久保留で 2011ms / 2024ms（V-9）。手順が throw しても `closing` は必ず `withTimeout` に渡る（V-4〜V-7） |
| AC-3（警告） | ✅ | タイムアウト時のみ 1 回。予算内 reject では出ない（V-7 / V-8）＝偽陽性なし。ミューテーションで回帰ガードの実効性も確認（V-18） |
| AC-4（戻り直後に拒否） | ✅ | 無注入 + 5 種のフォールト注入の**全 6 パターンで `ECONNREFUSED`**（V-12）。`close()` が `runShutdown()` の第 1 文であり `step()` にも包まれていないため（N-003）、他手順の成否から完全に独立している。`index.test.ts` の順序テストが `["close", "sse.shutdown", "closeAllConnections"]` を最初の `await` 前に固定 |
| AC-5 / AC-6（新規 /sse 拒否） | ✅ | `sse.shutdown()` は `shuttingDown = true` を最初に実行するため、以降の走査が途中で失敗しても 503 は保証される。実測でも `sse.shutdown()` 後の `/sse` は 503（V-12 の P4） |
| AC-7 / AC-8 | ✅ | 既存の `sse.test.ts` 検証は維持。加えて V-15 / V-16 で「`clients.add` されなかった client が keep-alive ループに入って生き残る経路は無い」ことを計装付きで確認（陽性対照あり） |
| AC-9 | ✅ | 271 tests pass（clean 11 回連続、フレーク無し） |

---

## 片付け

検証に使った worktree（`scratchpad/wt-conc-r3`）は `git worktree remove` で削除済み。フォールト注入・ミューテーションはすべてその worktree 内で行い、各実行後に `git checkout --` で復元した。メインの作業ツリー（`/Users/hikaru/github.com/tuanemuy/peek`）のソースは一切変更していない（本ファイルの書き込みを除く）。
