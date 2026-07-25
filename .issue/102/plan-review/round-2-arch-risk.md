# 計画レビュー Round 2 — アーキテクチャ整合性・実現可能性・リスク

**Issue:** #102
**対象:** `.issue/102/plan.md` / `.issue/102/adr.md`
**視点:** あるべきアーキテクチャとの整合性 / 実現可能性 / リスク
**検証環境:** Node v22.22.1, macOS (Darwin 25.4.0), hono 4.12.10, @hono/node-server 1.19.14, vitest 4.1.2

本レビューも静的読解だけでなく、`node_modules` の実コード読解・`pnpm typecheck`（tsgo）での実コンパイル・実プロセス／実ソケット／実 SIGINT による再現実験で裏を取っている。実験スクリプトはスクラッチパッドに置き、リポジトリには残していない（`git status` で確認済み）。

---

## 1周目指摘の解消状況

### アーキ視点（round-1-arch-risk.md）

- **[アーキ P-001]** AC-6 テストが構造的に落ちない → **解消**。AC-7（plan L29）が `shutdown({ timeoutMs: 20_000 })` の注入 + **500ms 未満**に書き換わった。注入値（20s）が閾値（500ms）を 40 倍上回るので「タイムアウトに救われた」場合は必ず落ちる。さらに「リスクと注意点」L447 に「CI で不安定なら閾値を緩めるのではなく `timeoutMs` の注入値を上げる」と明記され、退行の逃げ道も塞がれている。
- **[アーキ P-002]** keep-alive 停止の「第 3 層」が存在しない → **解消**。`node_modules/hono/dist/utils/stream.js` を再読して確認: `StreamingApi.write()` は `try { await this.writer.write(input); } catch { }` で例外を完全に握りつぶし、`return this` する。したがって `stream.write(...).catch(cleanup)` は決して発火しない。plan L207-223 / ADR-003 L144-151 が「2 層（主: per-client abort / 副: `while (!closed)` ガード）」に訂正され、`stream.write` 側の `.catch` は削除・`writeSSE` 側は保持、という方針分けも `sse.js` の実装（`event`/`id`/`retry` に `\r\n` があるときのみ throw）と一致している。永久 pending の可能性も plan L442 に記録済み。
- **[アーキ P-003]** AC-5 の `EventSource` 再接続の主張が偽 → **解消**。AC-5（L27）が「SSE ストリームを一切開始せず 503」というサーバー側で検証可能な事実に、AC-6（L28）が `clientCount` に分離された。ADR-003 L135-140 の 503 採用理由も差し替え済み。ステップ 9 の目視項目（L422）も「再試行が最大 10 回で止まる」に訂正されている。
- **[アーキ P-004]** `sleep()` の abort リスナーリーク → **解消**（ADR-006 / ステップ 6 / AC-8）。ただし **AC-8 の検証手段には別の問題がある（→ P-102）**。修正内容そのものは実測で正しい（下記 ADR-006 検証参照）。
- **[アーキ S-001]** `timeoutMs` がデッド API → **解消**。AC-7 のテストが実際に使う（plan L368）。
- **[アーキ S-002]** `src/lib/` 配置の根拠が事実誤認 → **解消**。plan L162 / ADR-001 L47 が「`timer.unref()` が Node 専用 API」に差し替わり、`src/lib/logger.ts` がクライアントから import されている事実も明記された。
- **[アーキ S-003]** ②に落ちた場合のワイヤ上の帰結 → **解消**（plan L205 / ADR-003 L142）。①と②の役割分担も書かれている。
- **[アーキ S-004]** `logger.warn` が `process.exit(0)` で取りこぼされる → **対応済みだが副作用あり**。stdio drain（ステップ 4 / ADR-007(1)）が入ったが、この drain 自体が新しい終了性バグを生む（→ **P-101**）。
- **[アーキ S-005]** 打ち切り時の後始末と doc コメント → **解消**（ADR-007(2) / plan L294）。再 `closeAllConnections()` が安全であることは実測で確認した（→ ただし効果は S-103）。
- **[アーキ S-006]** ADR-005 の削除基準の明文化 → **解消**（ADR-005 L227-231。`watcher` を残す判断と一貫）。
- **[アーキ S-007]** 「レースが成立しない」証明の根拠 → **解消**。plan L200 / ADR-003 L131 が「マイクロタスクは次のマクロタスクの前に必ず全て流れる」に差し替わり、Hono の fast path 依存が外れた。
- **[アーキ S-008]** Node 24 での確認 → **解消**（ステップ 9 L421）。
- **[アーキ S-009]** シグナル受信ログ → **解消**（ステップ 4 / ADR-007(3)）。ただし挿入位置に難あり（→ S-102）。

### カバレッジ視点（round-1-coverage.md）

- **[カバレッジ P-001]** AC-5 の後半が偽 → **解消**（アーキ P-003 と同一。AC-5/AC-6 に分割済み）。
- **[カバレッジ P-002]** 第 2 の SSE クライアント実装の調査漏れ → **解消**。`src/server/renderer/html-document.tsx` が関連ファイル表（L64）とスコープ「含まれないもの」（L48）の両方に入り、Issue 引用コードがこちらであることも明記された。
- **[カバレッジ P-003]** AC ↔ ステップの紐づけ → **解消**。全 10 AC を突き合わせ、ステップ 1〜9 が漏れなく参照され、逆にどの AC も存在しないステップを指していないことを確認した（AC-1→1,3,4,5 / AC-2→1,2,3 / AC-3→3,4,9 / AC-4→3,5 / AC-5→6,7 / AC-6→6,7 / AC-7→3,5 / AC-8→6,7 / AC-9→5,7 / AC-10→9）。
- **[カバレッジ P-004]** プロセスレベルの AC が無い → **解消**。AC-1（SIGINT 1 回・5 秒以内・exit code 0）が新設され、ステップ 5 に `spawn` + 実 SIGINT の自動検証が入った。**この検証手段が実際に成立することを本レビューで実測確認した**（下記「新規追加分の検証」5）。
- **[カバレッジ P-005]** AC-9（旧）の閾値矛盾と証明力 → **解消**。AC-10 の閾値が 5 秒に修正され、`SHUTDOWN_TIMEOUT_MS = 2_000` との整合が L36 で明示された。n=10 の限界も L34 に明記されている。
- **[カバレッジ S-001]** 型述語化の AC からの降格 → **解消**（スコープ L42）。
- **[カバレッジ S-002]** ADR-005 のスコープ明記 → **解消**（L43）。
- **[カバレッジ S-003]** `broadcast()` の no-op ガード削除 → **解消**（L388 で「追加しない」と明記）。
- **[カバレッジ S-004]** 実装の 2 段分割 → **解消**（グループ A / グループ B）。
- **[カバレッジ S-005]** ADR-002 が修正案 3 の後半を論駁していない → **解消**（ADR-002 L86）。
- **[カバレッジ S-006]** AC-7 の由来 → **解消**（L29 の由来欄が「回帰防止」に）。
- **[カバレッジ S-007]** `src/lib/` 配置根拠の出典 → **解消**（アーキ S-002 と同一）。

**→ 1 周目の指摘 21 件はすべて計画に反映されている。未解消・部分的なものは無い。** ただし反映のために追加された変更のうち 2 件に新たな問題がある（P-101 / P-102）。

---

## 新規追加分の検証（実測）

### 1. ADR-006（`node:timers/promises` への置き換え）— **妥当。主張はすべて実測で裏が取れた**

`node_modules/@types/node/timers/promises.d.ts` と `timers.d.ts` を読み、実行時挙動も測定した。

| 検証項目 | 結果 |
|---|---|
| シグネチャ | `setTimeout<T>(delay?, value?, options?: TimerOptions): Promise<T>`。`TimerOptions extends Abortable`（`signal?: AbortSignal`）+ `ref?: boolean`（既定 `true`） |
| Node 22 で使えるか | `@since v15.0.0`。`package.json` の `engines` は `>=22.0.0` なので問題なし |
| リスナーリーク（25 回正常完了後） | 手書き `sleep()` = **25 個** / `node:timers/promises` = **0 個**（`getEventListeners(signal,"abort").length`） |
| abort 時の挙動 | **reject する**。`AbortError`（`name: "AbortError"`, `code: "ABORT_ERR"`）。abort 後のリスナー数も 0 |
| 既に abort 済みの signal を渡した場合 | **即時 reject**（0ms）。※現行の手書き `sleep()` はこの場合リスナーが発火せず **30 秒待ち切る**（`addEventListener("abort")` は発火済み signal では呼ばれない）。到達経路は無いが、標準 API 化は堅牢性の面でも改善 |
| `unref` オプション | オプション名は `unref` ではなく `ref: boolean`。ADR-006 L316 の「既定で `ref: true`」という記述は正しい |
| 既存の `catch { break }` との整合 | 整合する。abort で必ず reject し、bare catch が受ける |

**唯一の挙動差**: 手書き版は `reject(signal.reason)`（カスタム reason を透過）だが、`node:timers/promises` は Node 22 では常に汎用 `AbortError` を投げる（`ac.abort(new Error("custom"))` でも `AbortError` になることを実測）。`catch { break }` が reason を見ないため**影響なし**。

`import { setTimeout as delay } from "node:timers/promises"` を含むコードが `pnpm typecheck`（tsgo）を通ることも確認済み。**リスクなし。この変更は採用してよい。**

### 2. `stream.write(...).catch(cleanup)` の削除 — **妥当**

`node_modules/hono/dist/utils/stream.js` の `write()` は `catch { }` で全例外を握りつぶし、必ず resolve する。`sse.js` の `writeSSE()` は `event`/`id`/`retry` に `\r\n` がある場合のみ throw し、それ以外は `this.write()` に落ちる。したがって:

- `stream.write(": keep-alive\n\n").catch(cleanup)` → **完全なデッドコード。削除して安全**（削除後も `await stream.write(...)` の永久 pending リスクは変わらず、`.catch` があっても救えなかった）。
- `client.send` の `writeSSE({event, data}).catch(cleanup)` → 保持する判断も正しい。実際には `event` は `"file-changed"` / `"tree-changed"` のリテラルのみなので発火しないが、削除すると将来 unhandled rejection の窓が開く。

### 3. タイムアウト打ち切り時の再 `closeAllConnections()` — **安全だが実効はほぼゼロ**

`http.Server.closeAllConnections()` を (a) 2 回連続、(b) `close()` のコールバック発火後、のいずれで呼んでも throw しないことを実測確認した。**副作用の観点では完全に安全**。ただし効果は S-103 参照。

### 4. `isHttpServer` 型述語 — **コンパイルを通る（再確認済み）**

`src/` 配下に一時ファイルを置いて `pnpm typecheck`（tsgo）を実行し、エラー 0 を確認した（実行後に削除、`git status` でクリーンを確認）。`if` 側で `closeAllConnections()` / `closeIdleConnections()` の両方が呼べること、`else` 側の narrowing も問題ないことを確認。1 周目の検証結果を引き継いでよい。

### 5. ステップ 5 の `spawn` + 実 SIGINT テスト — **実際に動くことを確認した**

現行コードのまま以下を実行し、`tsx` 経由でも `child.kill("SIGINT")` が届いて exit code 0 で終了することを確認した。

```
node_modules/.bin/tsx --import ./src/loaders/css.mjs src/index.ts . --port 39117 --no-open
→ /sse に接続（200 / text/event-stream）した状態で SIGINT
→ elapsed: 48ms, exit code: 0, "Server stopped. Bye!" まで出力
```

`tsx` が孫プロセスを挟んでシグナルを落とす、という懸念は無い。ステップ 5 の実現可能性は確認済み。

### 6. `timeoutMs: 0` でタイムアウト分岐を踏めない、という plan の主張 — **正しい**

`server.close(cb)` と `setTimeout(..., 0)` の順序を、接続なし / 接続 1 本 + `closeAllConnections()` の両条件で各 5 回測定し、**すべて `closeCb -> setTimeout0`** だった。plan L464 の記述は正確。ただしこれは「AC-3 を自動化できない」ことを意味しない（→ S-101）。

---

## 問題点（要修正）

- **[P-101]** **ステップ 4 の stdio drain は、`process.exit(0)` を uncaught EPIPE によるクラッシュ（exit code 1）に変えうる。AC-1（exit code 0）を直接壊す。**
  - 理由: `process.stdout` / `process.stderr` が pipe で、その読み手が既に消えている状態で書き込むと、Node は **非同期に `'error'` イベントを emit する**。現行コードは書き込み直後に `process.exit(0)` するためイベントが配送される前にプロセスが消えるが、**drain を `await` するとイベントループが 1 周し、`'error'` が配送されて uncaught exception になる**。`process.stdout` / `process.stderr` に既定の error ハンドラは無い。

    peek の shutdown ハンドラと同形（SIGINT → 3 行書き込み → drain → `process.exit(0)`）のスクリプトで実測:

    ```
    DRAIN=0 -> node exit code=0
    DRAIN=1 -> node exit code=1   (Error: write EPIPE / Unhandled 'error' event)
    ```

    しかもこれは机上の話ではない。**plan のステップ 9 が AC-3 の検証手順として指定している `peek . 2>&1 | tee /tmp/peek-shutdown.log` で Ctrl+C を押すと、SIGINT はフォアグラウンドプロセスグループ全体に届き `tee` が先に死ぬ**。その直後に peek が `outro()` と `logger.warn` を書けば EPIPE になる。`peek . | head`、ページャに繋いで途中で抜ける、CI のログ収集プロセスが先に落ちる、なども同じ経路。つまり「ログを取りこぼさないため」に入れた変更が、まさにログを取る手順の下で終了性を壊す。
  - 提案: 次のいずれか。
    1. **drain を残すなら、`await` する前に `process.stdout.on("error", () => {})` と `process.stderr.on("error", () => {})` を必ず登録する。** 実測でこれにより exit code 0 に戻り、drain のコールバックは `EPIPE` を第 1 引数で受けて正常に resolve することを確認済み（`drain=["cb","EPIPE"]` / `exit=0`）。登録位置は CLI 起動時（`run` の冒頭）が安全。
    2. **drain 自体を落とす。** 実測では、短い 1 行（`[peek] WARN ...` 相当）は pipe 越しでも `process.exit(0)` の直前に書けば `uv_try_write` で同期的に書き切られ、**欠落しない**（200KB を書いた場合のみ 64KB で切れる）。AC-3 の警告は 1 行なので、drain が救う場面は「直前に 64KB 超の未 flush 出力がある」場合に限られ、peek のシャットダウン経路では現実的に起きない。**費用対効果で見れば落とすのが妥当**。
  - どちらを採るにせよ、**現行の計画（error ハンドラ無しの裸の drain）は採用してはならない**。

- **[P-102]** **AC-8 の検証手段として指定されているテストは `sse.ts` を一切実行しない。Node 標準ライブラリの性質を assert しているだけで、実装が手書き `sleep()` に戻っても落ちない。**
  - 理由: ステップ 7 の記述は「`node:timers/promises` の `setTimeout` を短い間隔で N 回正常完了させ、`getEventListeners(signal, "abort").length` が 0 のままであることを直接 assert する」。これは `createSseManager` も keep-alive ループも通らない。plan は「実装が手書き `sleep()` に戻れば落ちる」と書いているが**成立しない**（実際に vitest 上で同形のテストを書いて、`sse.ts` と無関係に常に緑になることを確認した）。
    plan 自身が ADR-004 について「`in` のままでも typecheck は通るため、変更前後で常に真になる条件しか書けない。だから AC には含めない」と正しく判断しているのに、AC-8 は同じ誤りを犯している。
    実際に keep-alive ループを通して検証するには最低 2 つの仕掛けが要り、いずれも 3 行の修正に対して過大である:
    - `KEEP_ALIVE_INTERVAL_MS = 30_000` がモジュール定数なので、`createSseManager()` に間隔の注入口を開ける必要がある。
    - `abortController` はハンドラのクロージャ内にあり外から `signal` を掴めないので、テスト側で `AbortController` をラップして signal を捕捉する必要がある。
    - なお **vitest のフェイクタイマーは `node:timers/promises` を差し替えない**ことを実測確認した（`vi.advanceTimersByTimeAsync(30_000)` しても `delay(30_000)` は解決せず 30 秒でテストタイムアウト）。フェイクタイマー経由の迂回もできない。付言すると、これは ADR-006 の副作用でもある — 現行の手書き `sleep()` はグローバル `setTimeout` を使うためフェイクタイマーで制御できるが、置き換え後はできなくなる。
  - 提案: **AC-8 を受け入れ基準から外し、ADR-006 を ADR-004 / ADR-005 と同じ「含まれるもの（付随整理）」に位置づける。** 修正自体（手書き `sleep()` 削除 → `node:timers/promises`）は本レビューの実測で正しさが確定しており（25 → 0）、差分 3 行・挙動等価なので、テスト無しで入れて問題ない。ステップ 7 から当該テストを削除し、代わりに ADR-006 に「検証は本 ADR 記載の実測（25 → 0）をもって完了とし、回帰は `sse.ts` に手書き `sleep()` が再導入されないことをレビューで担保する」と書けば、plan の他の付随整理と扱いが揃う。
    どうしても自動テストを残したい場合は、上記の注入口（`createSseManager({ keepAliveIntervalMs })`）を開けたうえで `AbortController` を捕捉する形にすること。ただしこれは**本 Issue の要件（Ctrl+C で終了する）とは無関係な追加スコープ**なので、推奨しない。

---

## 改善提案（検討推奨）

- **[S-101]** `withTimeout` で `timeoutMs <= 0` のとき **executor 内で同期的に `{ status: "timed-out" }` を resolve する**特別扱いを入れれば、AC-3（タイムアウト時の `logger.warn`）を自動テストにできる。
  - 理由: plan L464 の「`timeoutMs: 0` では `closeCb` が `setTimeout0` より必ず先に流れるので分岐を踏めない」は実測どおり正しい（本レビューでも 10/10 で `closeCb -> setTimeout0`）。しかしそれは `setTimeout` に race させた場合の話で、`timeoutMs <= 0` を「予算ゼロ = 常にタイムアウト」として executor 内で即 resolve すれば、返り値の Promise が `closing` の settle より前に確定するため **決定的にタイムアウト分岐を踏める**。これで `shutdown({ timeoutMs: 0 })` + `logger.warn` のスパイにより AC-3 が自動検証可能になり、「真因切り分けの唯一の手掛かり」が手動確認頼みでなくなる。意味論としても素直で、`withTimeout` の単体テスト（ステップ 2）に 1 ケース足すだけで担保できる。

- **[S-102]** `logger.info(\`Received ${signal}, shutting down...\`)` の挿入位置を、`console.log()`（空行）の**後**にする。
  - 理由: 計画では「force exit 判定の直後」= 既存の `console.log()` より前になるため、実端末では `^C` のエコーと同じ行に `^C[peek] Received SIGINT, shutting down...` と連結して表示される。既存コードが `console.log()` で `^C` と `intro()` を分離している意図が崩れる。`console.log()` の後・`intro()` の前に置けば 1 行の追加で済み、clack のバー描画（`intro` 〜 `outro` の枠）も壊さない。
  - あわせて: この行の増分価値は「どのシグナルで起動したか」の識別のみである点は認識しておきたい。1 周目 S-009 が指摘したとおり、既存の `intro(" Shutting down... ")` の表示有無だけで (i)/(ii) の切り分けは既に可能（実測でも SIGINT 受信時に `┌ Shutting down...` が出ることを確認）。ADR-007 が「真因判明後は削除を検討」と書いているのは妥当な整理。

- **[S-103]** 打ち切り時の再 `closeAllConnections()` は「追加的に効く」とは書かない方がよい。
  - 理由: 呼び出しが安全であることは実測確認したが、**効く場面が構成上ほぼ存在しない**。手順 2 でリスニングハンドルを閉じているため手順 4 以降に新規ソケットが accept されることはなく、手順 4 で destroy 済みのソケットに再度 destroy しても no-op である。ADR-007(2) の「打ち切りの原因が『destroy し切れていないソケット』である場合には追加的に効く」は、その「destroy し切れていない」状態が `destroy()` の再呼び出しで解消する保証が無いため、根拠として弱い。2 行のコストなので残す判断でよいが、doc コメント / ADR には「冪等で無害な念のための後始末であり、既知の効果は無い」と正直に書く方が、将来の読者を誤らせない。

- **[S-104]** グループ A を単独でマージする場合の手動確認が定義されていない。
  - 理由: AC-3 と AC-10 が担保する挙動（タイムアウト警告 / Ctrl+C 10 回試行 / Node 24 での確認）は**すべてグループ A の変更に対する検証**なのに、それを実施するステップ 9 はグループ B の末尾にある。plan は「Issue の要件はグループ A だけで満たされるため、B で回帰が出ても要件充足分を残せる」と書いているが、その運用をすると要件充足分が手動確認されないままマージされる。ステップ 9 をグループ A の末尾にも置く（グループ B の後に再実施する）か、「分割マージする場合はステップ 9 を各グループで実施する」と明記すること。

- **[S-105]** ADR-007 L329 の「stderr が TTY でない場合は非同期になる」は一般化しすぎている。
  - 理由: Node の stdio の同期／非同期は接続先と OS で決まる。**ファイルは POSIX / Windows とも同期**、**TTY は POSIX で同期**、**pipe は macOS でのみ非同期**（Linux / Windows は同期）。実測でも、200KB を stderr に書いて即 `process.exit(0)` した場合、pipe では 65536 バイトで切れたが**ファイルリダイレクトでは全量（200013 バイト）が残った**。つまり計画が想定している「`2>&1 | tee log`」は macOS でのみ問題になりうる経路であり、`2> log` は元から安全。P-101 の判断材料としても効いてくるので、事実は正確に書いておきたい。

- **[S-106]** スコープ全体について: **落とすべきは P-101（drain）と P-102（AC-8）の 2 点のみ**で、それ以外は妥当。
  - 理由: ステップ 9・AC 10 件・ADR 7 件は「Ctrl+C で終了する」という 1 行の要件に対して確かに大きい。しかし内訳を見ると、要件を直接担うのはステップ 1〜5（グループ A）で、グループ B は (a) 差分 3 行で挙動等価な `node:timers/promises` 置き換え、(b) `if` 1 つ + 早期 return 1 つの追加、(c) 型定義から 2 フィールド削除、(d) 手動確認、しかない。**「直すために入れた変更が新しいバグを生む」リスクが最も高いのは、レース対策でも API 縮小でもなく、観測性のために CLI に足した stdio drain（P-101）である** — 唯一、終了パスそのものに `await` を挿入する変更であり、実際に exit code を 0 から 1 に変えることが実測で確認できた。次点は AC-8 のテスト（P-102）だが、これは害ではなく「無意味なコストと誤った安心」の問題。この 2 点を落とせば、残りは実測で裏の取れた低リスク変更のみになる。
  - 実装順序と依存関係については問題を検出できなかった。ステップ 1（`withTimeout`）→ 3（`shutdown` 有界化）→ 4（CLI、ステップ 1 に依存）→ 5（テスト、3・4 に依存）の順は正しく、**グループ A だけをマージしても動作は壊れない**（ステップ 3 は `sse.closeAll()` の呼び出し名をそのまま維持し、`ServerInstance` の型変更はステップ 8 = グループ B に置かれているため、`src/server/index.test.ts` / `src/server/routes/sse.test.ts` の既存 5 + 7 ケースはグループ A 単独で無改修のまま通る）。グループ B 側もステップ 6 が呼び出し側の追随まで含んでおり、ステップ単位でビルドが通る。

---

## 良い点

- **1 周目の 21 件を全件反映したうえで、反映によって生じた事実関係を自分で再検証している点。** 特に P-002 の訂正（`.catch(cleanup)` を「削除する / 残す」に分けた判断）は、`stream.js` と `sse.js` の両方を読まないと出せない結論で、本レビューで実コードを突き合わせても正しかった。「レビューで指摘されたから消す」ではなく「どちらを消すとどうなるか」を判定している。
- **ADR-006 の実測データが正確。** 「25 回正常完了後にリスナー 25 個 / 標準 API なら 0 個」を本レビューでも独立に再現した。加えて標準 API は「既に abort 済みの signal」でも即 reject する（手書き版は 30 秒待ち切る）という、計画が挙げていない追加の堅牢性も持つ。ADR-006 の「`ref` は既定 true なので keep-alive の意味論は変わらない」という注記も型定義どおりで正確。
- **AC-7 の作り直しが本質を突いている。** 「注入値を既定タイムアウトより大きくし、閾値を十分小さくする」ことで、タイムアウトに救われた実装が必ず落ちるテストになった。さらに「CI で不安定なら閾値ではなく注入値を上げよ」と、テストを骨抜きにする逃げ道まで先回りして塞いでいる。この種の「絶対に落ちないテスト」への感度は高く評価できる。
- **AC-1 のプロセスレベル自動テストが実際に成立する。** `tsx` 経由の `spawn` + `child.kill("SIGINT")` が届き、exit code 0 / 48ms で終了することを現行コードで実測確認した。Issue の唯一の要件が初めて回帰テスト化されるという計画の主張は、実現可能性の面で裏付けられている。
- **`timeoutMs: 0` でタイムアウト分岐を踏めない理由を実測で確かめ、AC-3 を安易に自動化したことにしなかった判断。** 「テストがあることにする」のが最も危険な失敗であり、`closeCb -> setTimeout0` の順序を確認して手動確認に留めた誠実さは正しい（そのうえで S-101 の余地はある）。
- **原因未特定という前提と、タイムアウト＝主／構造対策＝従という主従関係が 1 周目から一貫して保たれている。** 反映作業でステップと AC が増えても「要件充足を担っているのはタイムアウトのみ」という記述（plan L17 / L439、ADR-001）がぶれていない。真因が見つかっていない Issue でスコープが膨らむと、往々にしてこの軸が失われる。
- **CLAUDE.md の原則との整合も維持されている。** `TimeoutOutcome<T>` の判別可能ユニオン（`Result` / `TypedError` を無理に使わない理由も `src/core/error.ts` の `cause: Error` 必須という実装と一致）、`isHttpServer` 型述語、`shuttingDown` をクロージャに閉じ込めて `readonly` メソッド群を返すハンドル型パターンの踏襲は、いずれもリポジトリの既存様式（`createFileWatcher` の `let closed`、`startServer` の `shutdownPromise`）の素直な延長で、ステートレス志向からの逸脱にはあたらない。
