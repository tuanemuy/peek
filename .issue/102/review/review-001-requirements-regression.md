# Requirements & Regression Review #001

**Date:** 2026-07-25
**Round:** 1回目

---

## Summary

- Blockers: 0
- Warnings: 4
- Verdict: **APPROVED**

実装は Issue #102 の唯一の要件（Ctrl+C 1 回で必ず有限時間に終了する）を満たしており、SIGINT 受信から `process.exit(0)` までの経路に無界の待機点は残っていない。既存機能（ライブリロード / ポート衝突 / SIGTERM / force exit / CLI 出力 / 通常閲覧）にも回帰は確認できなかった。Warning 4 件はいずれもマージを止める性質のものではないが、うち 1 件（W-003）は **`testing.md` の期待結果が実装後の実態と食い違う**もので、Phase 4 のブラウザ検証前に手順の修正が必要。

### 検証環境についての前提（重要）

レビュー中、作業ツリーの `src/` が**並行して書き換えられている**ことを検知した（詳細は N-001）。そのため計測はすべて `git archive HEAD` で切り出した**汚染されないコピー**（`$SCRATCH/pristine`、HEAD = `3693d5d`）を `pnpm build` したうえで実施している。リポジトリ本体には一切の変更を残していない。

- Node: v22.22.1 / macOS (Darwin 25.4.0)
- 起動形態: `node dist/index.mjs <dir> --host 127.0.0.1 --port <空きポート> --no-open`

---

### Requirements & Regression

#### 受け入れ基準の検証

| AC | 内容 | 判定 | 根拠 |
|---|---|---|---|
| AC-1 | SSE 接続中に SIGINT 1 回で 5 秒以内・exit code 0 | **満たす** | `src/server/shutdown-process.test.ts`（spawn + 実 SIGINT）が存在し pass。加えて pristine ビルドで実測: SSE 1 本 6/6・SSE 0 本 3/3・SSE 3 本 3/3 すべて exit 0 / 6〜17ms。無言ソケット + 不完全リクエスト + SSE の混在でも 3/3 exit 0 / 16〜24ms。TTY（expect）で実 `^C` を送っても exit 0 |
| AC-2 | `server.close()` が永久に解決しなくても有限時間で settle | **満たす**（間接検証に加え直接検証も成立） | `src/lib/with-timeout.test.ts` が `new Promise(() => {})` を注入して検証。`shutdown()` の唯一の待機点が `withTimeout(closing, timeoutMs)`（`src/server/index.ts:239`）であることをコードで確認。さらに本レビューで pristine コピーの `close()` を `new Promise<void>(() => {})`（＝永久ハング）に差し替えてビルドし、**実 CLI で 2/2 とも 2015ms / 2009ms・exit 0** で終了することを確認した（計画が「実サーバーでは作れない」としていた状況を実機で再現し、AC-2 が end-to-end で成立することを確認） |
| AC-3 | `timeoutMs: 0` で決定的にタイムアウト分岐 + `logger.warn` / 既定値では偽陽性なし | **満たす** | `src/server/index.test.ts:111-142` の 2 ケースが pass。実機側も一致: 正常系 15 試行すべて `warned=false`、上記のハング注入版では `[peek] HTTP server did not close within 2000ms — ...` が出力され、`\| tee` 経由でもログに残ることを確認 |
| AC-4 | `shutdown()` から戻った直後（最初の await 前）にリスナーが閉じている | **満たす** | `src/server/index.ts:224-236` は `sse.shutdown()` → `close()` → `watcher.close()` → `closeAllConnections()` まで `await` を挟まない。テスト `stops accepting connections before shutdown() is awaited` が pass |
| AC-5 | シャットダウン後の `/sse` は 503、ストリームを開始しない | **満たす** | `src/server/routes/sse.ts:49-51` の早期 return（`c.body(null, 503)`）。テスト `GET /sse after shutdown responds 503 without starting a stream` が pass（`content-type` が `text/event-stream` でないことも検証済み） |
| AC-6 | シャットダウン後に `/sse` を叩いても `clientCount` が 0 のまま | **満たす** | テスト `GET /sse after shutdown does not register a client` / `shutdown resets clientCount to zero and refuses further clients` が pass |
| AC-7 | 接続済み SSE の body が keep-alive を待たず EOF に達する | **満たす**（判別性を実測で確認） | テスト `shutdown ends connected streams without waiting for the keep-alive interval` が pass。pristine コピーで `abortController.abort()` を削除する**ミューテーションを実施 → 当該テストのみ fail**（568ms でタイムアウト）。per-client abort が失われたら必ず落ちることを確認 |
| AC-8 | client 1 本あたりの abort リスナーが keep-alive 周回で増えない + positive control | **満たす**（3 方向の判別性を実測で確認） | テスト `does not accumulate abort listeners per client` が pass。pristine コピーで 2 種のミューテーションを実施: (b) 手書き `sleep()` に戻す → `expected [0,2,0,3,0,4,0,5,0,6] to include 1` で fail（PR 本文の `[2,3,4,5,6]` を再現）、(c) ②の再チェックを常に真 (`if (true as boolean)`) → `expect(sse.clientCount).toBe(1)` が捕捉して fail（他 3 ケースも同時に fail）。vacuous pass しないことを確認 |
| AC-9 | 既存のシャットダウン関連テストが引き続き通る | **満たす** | `pnpm test`: **27 files / 266 tests all pass**。削除されたテストは `closeAll does not throw with no clients` / `closeAll resets clientCount to zero` の 2 件で、いずれも `shutdown` 名の同等ケースに置き換わっている（diff 上 `it(` は +17 / −2 = 実質 +15 で PR 本文の「251 → 266」と一致） |
| AC-10 | 手動確認（ブラウザタブ常時オープン × Ctrl+C 10 回、所要時間・警告有無の記録） | **部分的（未実施）** | PR 本文どおり Phase 4 に予定されており、実装起因の不備ではない（→ W-001）。本レビューでヘッドレス相当の計測（実 SSE ソケット・実 SIGINT・実 TTY の `^C`・複数接続・パイプ経由）は網羅したが、**実ブラウザの `EventSource` / 10 分以上の放置 / Node 24 × macOS** は未カバー |

**総括: AC-1〜AC-9 は満たす。AC-10 のみ未実施（Phase 4 の作業項目）。**

#### Issue の唯一の要件に対するコードパスの追跡

`SIGINT` → `process.exit(0)` までの全経路を追い、無界の待機点が無いことを確認した。

```
src/index.ts:172 shutdown(signal)
  ├─ shuttingDown 二重押しガード → process.exit(1)         [有界]
  ├─ console.log() / logger.info() / intro()               [同期]
  ├─ await server.shutdown()                               ← 唯一の await
  │    src/server/index.ts:224
  │      1. sse.shutdown()          同期（flag→走査→clear、client.close は abort+delete のみ）
  │      2. const closing = close() 同期（server.close(cb) の呼び出し自体。リスナーは即閉じる）
  │      3. watcher.close()         同期
  │      4. closeAllConnections()   同期
  │      5. await withTimeout(closing, 2000)  ← 唯一の待機点。setTimeout で必ず settle
  ├─ catch → logger.error                                   [reject でも到達]
  ├─ outro()
  └─ process.exit(0)
```

- 5 の `withTimeout` はタイマー未 `unref()` かつ `clearTimeout` 済みで、発火しない経路が存在しない。`closing` が reject した場合は `withTimeout` が透過して `shutdown()` が reject → CLI の `catch` → `outro()` → `exit(0)` に到達する（AC-1 の「resolve でも reject でも成立」を満たす）。
- 1〜4 に throw があっても async IIFE の reject 経由で同じ `catch` に落ちる。
- `stream.write()` が永久 pending になっても、それは `streamSSE` のコールバック内であり `shutdown()` は待たない（計画の「リスクと注意点」記載どおり）。
- ハンドラ登録前（`startServer` 完了前）に SIGINT が来た場合は Node の既定動作でプロセスが終了するため、こちらもハングしない。

**結論: SIGINT 受信後にプロセスが有限時間で終了しない経路は見つからなかった。**

#### PR 本文の記述と実装の突き合わせ

| PR 本文の主張 | 実装 | 判定 |
|---|---|---|
| `src/lib/with-timeout.ts` 新規、既定 2 秒、予算ゼロ判定は `!(timeoutMs > 0)` で NaN も拾う | `with-timeout.ts:42`、`SHUTDOWN_TIMEOUT_MS = 2_000`（`index.ts:66`） | 一致 |
| タイマーは意図的に `unref()` しない（理由付き） | `unref()` の呼び出しなし。doc コメントに同趣旨の記述あり | 一致 |
| 打ち切り時は `logger.warn` で記録 | `index.ts:240-244` | 一致 |
| `shutdown()` に `timeoutMs` 注入可能 | `ServerInstance.shutdown(options?)` | 一致 |
| SseManager にシャットダウン中フラグ、`closeAll` → `shutdown` に終端化、二重チェック | `sse.ts:22,37-43,49-51,81-84` | 一致 |
| `server.close()` を `closeAllConnections()` より先に呼ぶ | `index.ts:229` → `index.ts:234` | 一致 |
| keep-alive の待機を `node:timers/promises` に置換 | `sse.ts:1,89-91`。手書き `sleep()` は削除済み | 一致 |
| `in` ナローイング → `isHttpServer` 型述語 | `index.ts:73-75`。`in` のインライン使用は消滅 | 一致 |
| `ServerInstance` から `close` / `sseCloseAll` を削除 | `index.ts:45-58`。`src/` 全体を grep して参照ゼロを確認（`dist/` の残骸は gitignore 対象のビルド成果物で、再ビルドで消える） | 一致 |
| SIGINT/SIGTERM の受信をログに残す | `index.ts:182`。`console.log()`（空行）の後・`intro()` の前という位置指定も守られている | 一致 |
| 採用しなかったもの: stdio drain / 打ち切り時の再 `closeAllConnections()` / `closeIdleConnections()` | いずれも実装に存在しない（grep 確認） | 一致 |
| `pnpm test`: 27 files / 266 tests all pass（251 → 15 件追加） | 実測 27 files / 266 tests pass。diff の `it(` は +17 / −2 = +15 | 一致 |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` すべて green | 実行して確認（いずれもエラーなし、109 files） | 一致 |
| 判別性の実測（abort 除去で EOF 来ず / 手書き sleep で `[2,3,4,5,6]` / 待機未到達で fail） | 本レビューで独立にミューテーションを実施し 3 方向とも再現 | 一致 |
| `StreamingApi.write()` は例外を握りつぶすので `.catch()` はデッドコード | `node_modules/hono/dist/utils/stream.js:34-41` の `try { ... } catch {}` を確認。`writeSSE` 側の `.catch(cleanup)` は残されている（計画どおり） | 一致 |

**PR 本文と実装の食い違いは発見できなかった。** 計画で「不採用」としたものの紛れ込みも、「実装する」としたものの漏れも無い。

#### 既存機能への回帰（実機検証）

すべて pristine ビルド（HEAD の `git archive` → `pnpm build`）で実施。

**1. ライブリロード（ディレクトリモード）— 回帰なし**

```
$ curl -N http://127.0.0.1:34610/sse
event: file-changed
data: {"path":"README.md"}     ← Markdown を編集

event: tree-changed
data: {}

event: file-changed
data: {"path":"ADDED.md"}      ← ファイル追加

event: tree-changed
data: {}

event: file-changed
data: {"path":"ADDED.md"}      ← ファイル削除

event: tree-changed
data: {}
```

`GET /` = 200、`GET /api/tree` = `[{"name":"README.md",...}]`、`GET /api/content?path=README.md` = shiki ハイライト済み HTML。503 の早期拒否・②の再チェック・`node:timers/promises` への差し替えのいずれも通常時の SSE を壊していない。

**2. ライブリロード（HTML ファイルモード）— 回帰なし**

`node dist/index.mjs <file>.html` で起動。トップレベル HTML に `EventSource` のインラインスクリプトが 1 件含まれ、ファイル編集で `event: file-changed / data: {}` が届く。Ctrl+C（`kill -INT`）でも即終了。

**3. `--port` 衝突時の起動失敗 — 回帰なし**

```
$ node dist/index.mjs <dir> --host 127.0.0.1 --port 34620 --no-open   # 2 つ目
◇  Failed to start server
└  Port 34620 is already in use
exit=1  (約 150ms、ハングして残らない)
```

`sse.closeAll()` → `sse.shutdown()` の改名は listen エラー経路（`index.ts:200`）に正しく追随している。

**4. SIGTERM 経路 — 回帰なし**

`kill -TERM`（SSE 接続 1 本あり）3/3 で exit 0 / 10〜13ms、`[peek] Received SIGTERM, shutting down...` を出力。SIGINT とシグナル名で判別できることも確認。

**5. 2 回目のシグナルによる force exit — コードは健在だが実質到達不能（→ W-003）**

正常系では 1 回目のシャットダウンが 10ms 前後で完了するため、2 回目のシグナルが届く前にプロセスが終了する。gap 0 / 2 / 3 / 4 / 5 / 6 / 8 / 30ms × 計 20 試行すべてで exit 0・`Force exiting...` 未出力。TTY で `^C` を 120ms 間隔で 2 回送っても `EXITSTATUS=0` で、2 回目の `^C` はエコーすらされない。
一方、`close()` を永久ハングさせた版では 2/2 とも **exit 1・`Force exiting...` 出力**を確認できたので、**分岐そのものは正しく動作している**（＝「押しても意味がない保険」という計画の位置づけどおり）。

**6. CLI の出力 — 回帰なし（正常系）**

実 TTY（expect）での出力（エスケープを可読化）:

```
└  Press Ctrl+C to stop

^C
[peek] Received SIGINT, shutting down...
┌   Shutting down...
│
└  Server stopped. Bye!

EXITSTATUS=0
```

`^C` のエコーと `[peek] Received SIGINT, ...` は `console.log()` の空行で分離されており**同じ行に連結していない**。clack の枠（`┌ Shutting down...` 〜 `└ Server stopped. Bye!`）も崩れていない。

**7. `ServerInstance` からの `close` / `sseCloseAll` 削除の影響 — 残存参照なし**

`src/` 全体を grep して `sseCloseAll` の参照は 0 件、`ServerInstance` 経由の `.close()` 呼び出しも 0 件。`dist/index.mjs` に旧シンボルが残っていたのは gitignore 対象の古いビルド成果物で、再ビルドで消滅することを確認済み。

**8. その他の閲覧機能 — 回帰なし**

Markdown 単一ファイルモード + `--css` でカスタム CSS が HTML に注入されることを確認（`color:red` が 1 件ヒット）。ディレクトリブラウズ / ツリー API / シンタックスハイライトも上記 1 のとおり正常。

**9. 品質ゲート**

`pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`（266 pass）すべて green。

#### `testing.md` の実行可能性

| 項目 | 判定 | 備考 |
|---|---|---|
| 起動手順（`pnpm build` → `node dist/index.mjs ...`） | 実行可能 | 実際にビルド・起動して確認 |
| HTML モードの対象 `testdata/html/01-basic-structure.html` | 実在 | ファイル確認済み |
| 警告文の検索キー `did not close within` | 実装と一致 | 実際の文言は `[peek] HTTP server did not close within 2000ms — giving up and leaving the remaining sockets to the caller.` |
| `Received SIGINT, shutting down...` の確認 | 実装と一致 | 出力を確認 |
| 項目 1 の確認ポイント（`^C` と同じ行に連結しない / 枠が崩れない） | 実装と一致 | 上記 6 |
| エッジケース 2（`\| tee` 経由で警告が欠落しない） | 実行可能 | ハング注入版で警告がログに残ることを確認 |
| エッジケース 3（SIGTERM で exit 0・`Received SIGTERM`） | 実装と一致 | 上記 4 |
| エッジケース 4（SSE 無しのベースライン） | 実装と一致 | 3/3 exit 0 / 14〜17ms |
| **エッジケース 1（Ctrl+C 2 回 → `Force exiting...` / exit 1）** | **期待結果が実態と食い違う** | → W-003 |

#### Blockers

なし

#### Warnings

- **[W-001]** AC-10（手動確認 10 回とその記録）が未実施
  - 場所: `.issue/102/plan.md:32`（AC-10） / PR 本文「ブラウザ検証（Phase 4 で実施予定）」
  - 理由: 受け入れ基準 10 件のうち唯一未達。ただし PR 本文が明示的に Phase 4 の作業として宣言しており、**実装起因の不備ではない**ため Blocker にはしない。実ブラウザの `EventSource`・10 分以上の放置・Node 24 × macOS は本レビューのヘッドレス計測では埋められていない。
  - 提案: Phase 4 で AC-10 を実施し、計画ステップ 9 が要求する 3 記録（`Received SIGINT` の有無 / 所要時間 / 警告の有無）を PR に追記する。特に「10 回とも警告なし」という観測は、真因が生きたままタイムアウトに救われているのかを切り分ける唯一の材料なので、出なかった事実も明記すること。

- **[W-002]** タイムアウト警告が clack の枠内に割り込む
  - 場所: `src/server/index.ts:240-244`（`logger.warn`）
  - 理由: 警告が出るケースの実出力は次のようになり、`┌ Shutting down...` と `│` の間に枠線を持たない行が挟まる。
    ```
    ┌   Shutting down...
    [peek] HTTP server did not close within 2000ms — giving up and ...
    │
    └  Server stopped. Bye!
    ```
    `testing.md` 項目 1 の確認ポイント「clack の枠が崩れていないこと」は、警告が出た試行では**必ず不成立**になる。正常系では警告が出ないので通常は見えないが、Phase 4 で警告が出た場合に「枠が崩れた＝別のバグ」と誤判定されうる。
  - 提案: 実装を変える必要はない（観測性を優先した設計として妥当）。`testing.md` 項目 1 の確認ポイントに「タイムアウト警告が出た場合は枠内に 1 行割り込むのが正常」と 1 行補記するか、`log.warn`（clack）を使うかのどちらか。前者を推奨。

- **[W-003]** `testing.md` エッジケース 1 の期待結果が、実装後のコードでは通常再現しない
  - 場所: `.issue/102/testing.md:177-183`
  - 理由: 有界化によりシャットダウンが 10ms 前後で完了するようになったため、人間が「素早く 2 回」押しても 2 回目は既に終了したプロセスに届く。実測で gap 0〜30ms の 20 試行すべてが exit 0・`Force exiting...` 未出力、TTY での 120ms 間隔の `^C` × 2 も `EXITSTATUS=0`。手順どおりに実施すると**期待結果（`Force exiting...` が表示され exit code 1）を満たさず、検証者が「force exit 経路が壊れた」と誤って判断する**。実際には分岐は健在で、`server.close()` を永久ハングさせた版では 2/2 とも exit 1 で `Force exiting...` が出る。
  - 提案: エッジケース 1 の期待結果を「1 回目のシャットダウンが極めて速いため、通常は 2 回目が届く前に exit 0 で終了する。`Force exiting...` が出た場合も出ない場合も正常。**どちらの場合もハングしないこと**が確認項目」に書き換える。あわせて「exit code は 0 でも 1 でもよい」と明記する。

- **[W-004]** 終了性の自動テストが `bin` の実体（`dist/index.mjs`）を一度も起動しない
  - 場所: `src/server/shutdown-process.test.ts:59-73`
  - 理由: AC-1 のプロセステストは `node --import tsx/esm src/index.ts` を spawn するソース経路のみで、`package.json` の `bin.peek` が指す **`dist/index.mjs`（rolldown/tsdown のバンドル出力）は CI でも一度も起動されない**。Issue の報告者が実際に踏んだのはバンドル成果物である。バンドラ由来の差異（コード生成・DCE・トップレベル await の扱い等）が入り込んだ場合、266 件のテストが全部 green のままユーザーだけがハングする経路が残る。
  - 提案: 必須ではない（本 Issue のスコープを超える）。フォローアップ Issue として「`pnpm build` 後の `dist/index.mjs` に対して同じ SIGINT 終了性テストを 1 ケースだけ回す（CI の build ジョブの後段）」を検討するとよい。本レビューでは pristine ビルドの `dist/index.mjs` に対して実 SIGINT を 15 回以上送り、すべて exit 0 であることを手で確認済み。

#### Notes

- **[N-001]** レビュー中、作業ツリーの `src/` が並行して書き換えられていた
  - レビュー開始時点（16:23）に `src/server/routes/sse.ts` が未コミット変更を持ち、内容は ②の再チェックを `if (true as boolean)` に置換したもの（＝判別性ミューテーションの実験）だった。バックアップを取ったうえで `git checkout -- src/server/routes/sse.ts` で復元している（バックアップ: スクラッチパッドの `sse.ts.dirty-backup`）。
  - その後も `src/server/index.ts` / `src/lib/with-timeout.ts` の mtime が更新され続け、ある瞬間のビルドでは `outcome.status === "timed-out"` が別の比較に置換された `dist` が生成された（そのビルドでは正常系でも常に警告が出た）。`.issue/102/review/` に他観点のレビューファイルが同時刻に作成されていることから、**並行して走っている他のレビューエージェントによるミューテーション実験**と判断した。**コミット済みの PR 内容にこの種の残骸は一切含まれていない**（`git archive HEAD` から再ビルドすると常に正しいコードが得られることを 4 回確認）。
  - 以降の実機検証はすべて汚染されない pristine コピーで実施している。レビュー完了時点の `git status --porcelain` は `?? .issue/102/review/`（レビューファイル群）のみ。

- **[N-002]** テストの判別性を独立に再現した（PR 本文の主張は正しい）
  - `abortController.abort()` を削除 → `shutdown ends connected streams ...` のみ fail。
  - 手書き `sleep()` に戻す → `does not accumulate abort listeners per client` が `expected [0,2,0,3,0,4,0,5,0,6] to include 1` で fail（PR 本文の `[2,3,4,5,6]` と一致）。
  - ②の再チェックを常に真にする → `clientCount` の positive control が捕捉して fail（他 3 ケースも同時に fail）。vacuous pass しない。

- **[N-003]** 実機計測サマリ（pristine ビルド、Node v22.22.1 / macOS）

  | 条件 | 試行 | exit | SIGINT→exit | 警告 |
  |---|---|---|---|---|
  | SSE 1 本 + SIGINT | 6 | 0 | 6〜17ms | なし |
  | SSE なし + SIGINT | 3 | 0 | 14〜17ms | なし |
  | SSE 3 本 + SIGINT | 3 | 0 | 12〜14ms | なし |
  | 無言ソケット + 不完全リクエスト + SSE + SIGINT | 3 | 0 | 16〜24ms | なし |
  | SSE 1 本 + SIGTERM | 3 | 0 | 10〜13ms | なし |
  | 実 TTY で `^C` | 1 | 0 | 即時 | なし |
  | `close()` 永久ハング注入 + SIGINT | 2 | 0 | 2015 / 2009ms | **あり** |
  | `close()` 永久ハング注入 + SIGINT × 2 | 2 | **1** | 209 / 213ms | なし（force exit） |

  正常系で一度も警告が出ないこと（AC-3 の偽陽性なし）と、真にハングする状況では確実に 2 秒で打ち切って exit 0 になること（AC-1 / AC-2）の両方を実機で確認できている。

- **[N-004]** Issue 本文の修正案との対応: 案 1（新規接続を先に止める + シャットダウン中フラグ）と案 2（タイムアウト付き強制終了）を両方採用し、案 3 の `closeIdleConnections()` 併用のみ明示的に不採用。計画の「主従（要件充足はタイムアウトが単独で担保、構造対策は再発防止）」が PR 本文でも維持されており、実装もその通りになっている。

- **[N-005]** `SHUTDOWN_TIMEOUT_MS = 2_000` は CLI から変更できない（`timeoutMs` はテスト注入専用）。Phase 4 で「毎回警告が出る」観測が得られた場合は真因が生きている可能性が高いので、計画の「リスクと注意点」どおり別 Issue で追跡すること。
