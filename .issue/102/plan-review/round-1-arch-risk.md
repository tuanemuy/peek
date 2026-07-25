# 計画レビュー Round 1 — アーキテクチャ整合性・実現可能性・リスク

**Issue:** #102
**対象:** `.issue/102/plan.md` / `.issue/102/adr.md`
**視点:** あるべきアーキテクチャとの整合性 / 実現可能性 / リスク
**検証環境:** Node v22.22.1, macOS (Darwin 25.4.0), hono 4.12.10, @hono/node-server 1.19.14
（Issue 報告者の環境は Node v24.15.0。差分は「2. 真因の再調査」で扱う）

このレビューは静的読解だけでなく、`node_modules` の実コードの読解と、実サーバー・実ソケット・実 SIGINT を使った再現実験によって裏を取っている。実験スクリプトは使い捨てで、リポジトリには残していない。

---

## 1. 「Issue 本文のレースは現行コードでは成立しない」の検証

### 結論: **プランナーの主張は正しい。** 根拠 (a)(b)(c) はいずれも実コードで裏が取れた。

#### (a) `shutdown()` は `server.close()` 呼び出しまで `await` を挟まない — **正しい**

`src/server/index.ts:179-201`:

```ts
const close = () =>
  new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
...
shutdownPromise = (async () => {
  sseCloseAll();
  watcher.close();
  if ("closeAllConnections" in server) {
    server.closeAllConnections();
  }
  await close();
})();
```

`async` 関数の本体は最初の `await` まで同期実行され、`Promise` の executor も同期実行される。したがって `server.close()` は `shutdown()` の呼び出しと同一の同期ターンで呼ばれる。`sseCloseAll()` / `watcher.close()` / `closeAllConnections()` もすべて同期関数である（`src/lib/watcher.ts:70-81` の `close()` は同期・冪等、`src/server/routes/sse.ts:41-46` の `closeAll()` も同期）。

#### (b) SIGINT ハンドラはマクロタスクなので割り込めない — **正しい（ただし理由の書き方は不正確、S-007 参照）**

正確には「マクロタスクだから」ではなく「**マイクロタスクは次のマクロタスクの前に必ず全て流れる**」が本質である。SIGINT ハンドラも `request` / `connection` イベントもマクロタスクであり、単一スレッド上で互いに割り込めない。この点は結論に影響しない。

#### (c) Hono の `streamSSE` は `run(cb)` を同期呼び出しする — **正しい**

`node_modules/hono/dist/helper/streaming/sse.js`:

```js
var run = async (stream, cb, onError) => {
  try {
    await cb(stream);          // ← cb は同期的に呼ばれ、最初の await まで同期実行される
  } catch (e) { ... }
  finally { stream.close(); }
};
var streamSSE = (c, cb, onError) => {
  ...
  run(stream, cb, onError);    // ← await されていない = 同期呼び出し
  return c.newResponse(stream.responseReadable);
};
```

さらに上流も同期であることを確認した。

`node_modules/hono/dist/hono-base.js:285-297`（**単一ハンドラマッチの fast path**）:

```js
if (matchResult[0].length === 1) {
  let res;
  try {
    res = matchResult[0][0][0][0](c, async () => { c.res = await this.#notFoundHandler(c); });
  } catch (err) { return this.#handleError(err, c); }
  return res instanceof Promise ? res.then(...) : res ?? this.#notFoundHandler(c);
}
```

`/sse` はミドルウェア無しの単一ハンドラなのでこの経路に入り、ハンドラは `#dispatch` から**完全に同期呼び出し**される。

`node_modules/@hono/node-server/dist/server.js`（`getRequestListener` の返り値）:

```js
return async (incoming, outgoing) => {
  ...
  res = fetchCallback(req, { incoming, outgoing });   // ← app.fetch を同期呼び出し
  ...
};
```

Node の `request` イベントハンドラ → `fetchCallback` → `#dispatch` → ハンドラ → `streamSSE` → `run` → `cb` → `clients.add(client)` まで、**一切の `await` を挟まない同期チェーン**である。

#### したがって

Issue 記載の「`closeAll()` の後に `clients` へ追加される client」は現行コードでは発生しない。プランナーがこの結論を出したうえで「原因未特定」を明示し、それを設計方針の前提に据えた判断は正しい。**計画の根幹は変わらない。**

ただし補強として:

- 仮に将来 `app.use(...)` を 1 つでも足すと `matchResult[0].length > 1` になり `compose` 経路（`hono-base.js:298-311` の async IIFE）に落ちる。その場合ハンドラ呼び出しはマイクロタスク境界を跨ぐが、**同一マクロタスク内なので結論は変わらない**。ADR-003 が言う「将来 Hono のディスパッチが非同期化しても壊れない」は、新設計（フラグ + 再チェック）については正しい。

---

## 2. 真因の再調査（独自調査）

### 結論: **再現できなかった。ただし「`closeAllConnections()` が取りこぼす」系の候補はほぼ全て潰せた。** 最有力候補は Node バージョン差、次点で「そもそも `server.close()` ではない」。

以下は本レビューで実際に走らせた実験である（すべて Node v22.22.1 / macOS）。

#### 実験 A: `startServer()` を使った実シナリオ 8 種

| シナリオ | 結果 |
|---|---|
| クライアント無し | resolved 0ms |
| SSE 1 本（再接続なし） | resolved 3ms |
| SSE 1 本 + 即時再接続ループ | resolved 0ms |
| SSE 3 本 + 即時再接続ループ | resolved 1ms |
| アイドル keep-alive ソケットのみ（ブラウザの接続プール相当） | resolved 1ms |
| SSE + アイドル keep-alive + 再接続 | resolved 1ms |
| 接続だけして 1 バイトも送らないソケット | resolved 0ms |
| SSE + 無言ソケット | resolved 3ms |

→ **候補 (a)(b)(g) は否定的。** `closeAllConnections()` は idle / 無言 / SSE いずれのソケットも destroy し、`_connections` は同期的に 0 になる。

#### 実験 B: 接続ストーム（peek と同形の Hono アプリを直接計測）

40 本の SSE 接続を張り、1ms 間隔でランダムに切断→即再接続させ続けた状態で、peek と同一手順のシャットダウンを実行:

```
before shutdown        _connections = 40
after closeAllConnections _connections = 0     ← 同期的に 0 になる
server.close()         resolved 3ms
```

→ `http.Server.prototype.closeAllConnections()` は `server._connections` を**同期的に**ゼロにする。「destroy したソケットが `_connections` を減らさない」候補 (a) はこの構成では起きない。

#### 実験 C: 送信バックプレッシャー下でのシャットダウン

SSE ストリームが 64KB チャンクを書き続けている最中に、ピアが一切読まない（`data` ハンドラ未登録）状態を作り、シャットダウン:

```
clients: 3, _connections: 3
after closeAllConnections _connections = 0
shutdown -> resolved 3ms
stream callbacks that returned: 3 / 3
```

→ 候補 (e)（`await stream.write()` に滞留中の abort）も、少なくとも本構成では `server.close()` を止めない。

#### 実験 D: 実 CLI に実 SIGINT を送る E2E（12 回）

`src/index.ts` をそのまま起動（`--host 0.0.0.0`、ディレクトリモード、`peek .` 相当）し、SSE 2 本 + 即時再接続ループ + アイドル keep-alive プール 2 本を張った状態で `SIGINT` を送る試行を 12 回:

```
hangs = 0/12, max = 64ms（全て exit code 0）
```

→ CLI 層（`@clack/prompts` のフック含む）も含めて再現せず。

#### 実験 E: `sleep()` の abort リスナー蓄積（候補 (f)）— **唯一、実測で確認できた欠陥**

`src/server/routes/sse.ts:9-21` の `sleep()` は、**正常にタイムアウトで解決した場合に abort リスナーを外さない**。`{ once: true }` は「発火したら外す」であって「解決したら外す」ではない。

```js
// 25 回 sleep を正常完了させた後の計測
getEventListeners(ac.signal, "abort").length === 25
```

keep-alive は 30 秒周期なので、**SSE クライアント 1 本あたり毎時 120 個**のリスナーとクロージャが `AbortSignal` に積み上がる。Issue 本文の「**ブラウザのプレビュータブを開いたままにしているほど踏みやすい**」という観測プロファイルと一致する唯一の実測済み欠陥である。ただしリスナーの蓄積そのものが `server.close()` を止める機序は見つかっていない（`abort()` は数千個でも同期で一瞬で流れる）。→ P-004。

#### 潰せていない候補と、次にやるべきこと

1. **Node バージョン差（最有力）。** 報告者は v24.15.0、本レビューは v22.22.1。`closeAllConnections()` の実体は C++ 側 `ConnectionsList` に依存しており、版差の余地がある。**上記の実験 A/B/D を Node 24 で再実行するのがコスト最小で最も価値が高い次の一手**。plan のステップ 7 に「報告者環境（Node 24）で再現スクリプトを回す」を追加すべき（S-008）。
2. **「そもそも `await close()` ではない」可能性。** Issue の「SIGTERM で即座に終了した」という観測は、(i) SIGINT ハンドラが `await server.shutdown()` で停止 → SIGTERM が force exit 分岐（`process.exit(1)`）に落ちた、と (ii) **SIGINT ハンドラがそもそも起動していなかった** → SIGTERM で初めて正常終了した、の**両方と整合する**。plan は (i) を前提にしているが、(ii) を排除できていない。plan が入れる `logger.warn`（AC-2）に加えて、**シャットダウン開始直後・各ステップ通過時にもログを出す**（少なくとも一時的に）と、次回再発時に (i)/(ii) を切り分けられる。→ S-009。
3. 候補 (c)（`stream.close()` の `finally` が完了しない）は起こりうるが、`closeAllConnections()` がソケットを destroy する以上 `server.close()` はブロックしない（実験 C で確認）。
4. 候補 (d)（Hono の abort ハンドリング）は `StreamingApi.abort()` が `aborted` フラグで冪等、`onAbort` 購読者は同期実行、という実装（`node_modules/hono/dist/utils/stream.js`）で問題なし。

**この不確実性は plan の設計判断を否定しない。** むしろ ADR-001 の「原因未特定だからタイムアウトが AC の唯一の保証手段」という立て方を強く支持する結果である。

---

## 問題点（要修正）

- **[P-001]** ステップ 5 の AC-6 テスト（「SSE 接続中でも 3 秒以内に解決」）は、`SHUTDOWN_TIMEOUT_MS = 2_000` の存在によって**構造的に絶対に落ちない**。
  - 理由: `shutdown()` は最悪でも 2 秒 + α で必ず resolve するよう設計されている。閾値 3 秒はその上にあるので、`server.close()` が永久にハングしても、SSE ストリームが 30 秒間 abort されなくても、テストは常に緑になる。AC-6 の「keep-alive 間隔を待たずに解決する」という主張を一切検証できていない。plan の「リスクと注意点」では「CI 環境では閾値（3 秒）に余裕を持たせる」と書かれているが、余裕を持たせるほどテストは無意味になる。
  - 提案: このテストで `shutdown({ timeoutMs: 20_000 })` を注入し、閾値を **1 秒未満**（例えば 500ms）に下げる。こうすれば「タイムアウトに救われた」場合はテストが落ち、「abort でループが即座に抜けた」場合だけ通る。`timeoutMs` オプションが初めて存在意義を持つ（S-001 と対で解決する）。

- **[P-002]** 「keep-alive ループ停止の 3 層」のうち**第 3 層は存在しない**。ADR-003 / plan の「最終: `closeAllConnections()` によるソケット破棄で `stream.write()` が reject → `.catch(cleanup)`」という記述は誤り。
  - 理由: Hono の `StreamingApi.write()` は例外を握りつぶす（`node_modules/hono/dist/utils/stream.js`）。

    ```js
    async write(input) {
      try {
        if (typeof input === "string") { input = this.encoder.encode(input); }
        await this.writer.write(input);
      } catch { }        // ← すべて握りつぶして resolve する
      return this;
    }
    ```

    したがって `src/server/routes/sse.ts:84` の `await stream.write(": keep-alive\n\n").catch(cleanup)` の `.catch(cleanup)` は**決して発火しないデッドコード**である。同じ理由で `client.send` の `stream.writeSSE({...}).catch(cleanup)`（`sse.ts:66`）も実質デッドコードになる（`writeSSE` は `event`/`id` に改行が混ざった場合しか throw しない）。さらに、消費側が pull を止めた場合 `writer.write()` は reject ではなく**永久に pending** になりうるため、「reject するから抜けられる」という前提自体が二重に成り立たない。
  - 提案: ADR-003 と plan の「3 層」の記述を「主: per-client abort / 副: `while (!closed)` ガード」の**2 層**に訂正する。そのうえで、`stream.write()` が永久 pending になった場合に `run()` の `finally { stream.close() }` が走らずコールバックが返らない可能性があることを「リスクと注意点」に明記する（ソケットは `closeAllConnections()` で destroy 済みなので `server.close()` は止まらないが、事実として記録すべき）。`.catch(cleanup)` を残すか消すかも明示的に決めること（消すなら「Hono が握りつぶすため無意味」というコメントを残す）。

- **[P-003]** AC-5「シャットダウン開始後の `/sse` は 503 を返し、**ブラウザ `EventSource` が再接続ループに入らない**」は、peek のクライアント実装に対しては成り立たない。
  - 理由: `src/client/lib/sse.ts` は `EventSource` の組み込み再接続に頼らず、**独自の手動リトライを実装している**。

    ```ts
    evtSource.onerror = () => {
      evtSource.close();
      ...
      retryCount++;
      if (retryCount > SSE_MAX_RETRIES) { ...; return; }
      const delay = Math.min(SSE_INITIAL_RETRY_MS * 2 ** (retryCount - 1), SSE_MAX_RETRY_MS);
      retryTimer = setTimeout(connect, delay);   // ← 新しい EventSource を作り直す
    };
    ```

    非 2xx で `EventSource` が恒久 CLOSED になっても `onerror` は発火するため、peek のクライアントは 503 でも**新しい `EventSource` を最大 10 回張り直す**。「503 なら再接続しない」という ADR-003 の根拠は、素の `EventSource` にしか当てはまらない。結果として、503 を返しても「リスナーを閉じてしまう」場合と再接続挙動は**同じ**であり、503 採用の実利はほぼ無い（無害ではあるが）。
  - 提案: (1) AC-5 の後半（「再接続ループに入らない」）を削除するか「サーバー側が新規 SSE ストリームを開始しないこと」に書き換える。(2) ADR-003 の 503 採用理由を「ストリームを一切生成しないので軽く、意図が明確」に差し替える（この理由なら正しい）。(3) ステップ 7 の手動確認「DevTools の Network で `/sse` の再試行が発生しないことを目視する」は**必ず失敗する検証条件**なので、「シャットダウン後の `/sse` 再試行がすべて失敗し、10 回で収束すること」に書き換える。

- **[P-004]** `src/server/routes/sse.ts` の `sleep()` が、正常完了のたびに abort リスナーを 1 個ずつリークする（実測で確認済み: 25 回の正常 sleep 後に `AbortSignal` のリスナー 25 個）。plan はこのファイルを触るのに、この欠陥に言及していない。
  - 理由: `{ once: true }` は「発火時に外す」オプションであり、`setTimeout` が先に解決したケースではリスナーが残り続ける。keep-alive 周期は 30 秒なので **SSE 1 本あたり毎時 120 個**のリスナー + クロージャが `abortController.signal` に蓄積する。Issue 本文が挙げる「ブラウザのプレビュータブを開いたままにしているほど踏みやすい」という時間依存の症状プロファイルと一致する、本調査で唯一実測できた defect である。加えて Node は EventTarget のリスナー超過で `MaxListenersExceededWarning` を出しうる。
  - 提案: `sleep()` を Node 標準の中断可能タイマーに置き換える。これでリークが構造的に消え、`sse.ts` から手書きの `sleep` ヘルパー自体が不要になる。

    ```ts
    import { setTimeout as delay } from "node:timers/promises";
    // ...
    try {
      await delay(KEEP_ALIVE_INTERVAL_MS, undefined, { signal: abortController.signal });
    } catch {
      break;
    }
    ```

    plan のステップ 2（`sse.ts` の改修）に含めるのが自然。スコープ外に見えるが、(a) 同一ファイル・同一関数群の改修中である、(b) Issue の症状プロファイルと一致する唯一の実測欠陥である、(c) 差分が小さい、の 3 点で本 Issue に含める妥当性がある。含めない判断をする場合でも、**別 Issue として起票する旨を plan に明記**すること。

---

## 改善提案（検討推奨）

- **[S-001]** `shutdown({ timeoutMs })` オプションは、計画中の**どのテストからも使われていない**（ステップ 5 のテストは既定値 2 秒に依存し、ステップ 6 は `withTimeout` を直接叩く）。「テスト注入のため」という導入理由が実際には満たされていないので、現状のままだとデッド API になる。
  - 理由: ADR-005 は「誤用経路を型レベルで消す」ために `close` / `sseCloseAll` を削除しているのに、同じ ADR で使われないオプションを追加するのは方針として一貫しない。P-001 の修正でこのオプションを実際に使えば、追加の正当性と「メモ化により 2 回目以降は無視される」という直感に反する挙動のコストが釣り合う。使わないなら削除すべき。

- **[S-002]** `withTimeout` を `src/lib/` に置く**結論は妥当だが、plan / ADR-001 に書かれている理由は事実誤認**。
  - 理由: plan は「`src/core/` はクライアントバンドルに入りうる層だから `src/lib/`」としているが、`src/client/lib/sse.ts` は `import { logger } from "../../lib/logger.js";` として **`src/lib/` を実際にクライアントから import している**。つまり「`src/lib/` = サーバー専用」は成り立たない。正しい判断根拠は `.issue/89/adr.md` ADR-001 が実際に書いている区分、すなわち「`src/core/` はフレームワーク/ランタイム非依存層」である。`withTimeout` は plan 自身が要求している `timer.unref()` を使うため **Node 依存**であり、その一点で `src/lib/` が正しい。理由をこちらに差し替えれば、レビューでも将来の読者にも通る。`src/server/index.ts` へのインライン案より、ステップ 6 の単体テスト（AC-1 を決定的に検証できる唯一の場所）が書けるぶん切り出しが優る、という plan の判断は支持する。

- **[S-003]** `/sse` ハンドラ内②の再チェックで `cleanup(); return;` した場合、クライアントには **HTTP 200 + `text/event-stream` + 即 EOF** が返る（`streamSSE` は `c.newResponse(...)` を返した後にストリームを閉じるため）。これは ADR-003 が「200 + 即クローズは再接続ループを誘発するので避ける」と言っている挙動そのものである。
  - 理由: 「どちらの順でも取りこぼしが無い」という正しさの主張は成立しているが、②に落ちたときのワイヤ上の帰結が書かれていないため、レビュアが「503 を返す設計」と矛盾していると読む。窓は極小（同期ブロック間の順序が逆転したときだけ）なので実害は無いが、ADR-003 に「②に落ちた場合のみ 200 + 即 EOF になる。窓は 1 回のシャットダウンにつき最大 1 接続で、クライアントは既存のリトライで収束する」と一行足すべき。

- **[S-004]** AC-2 の `logger.warn` が、`src/index.ts` の `process.exit(0)` によって**取りこぼされうる**。
  - 理由: `logger.warn` は `console.warn` = stderr への書き込みで、stderr が TTY でない場合（`peek . 2>&1 | tee log`、CI、ログ収集）は非同期になる。plan は AC-2 の警告ログを「構造対策で直ったのか、タイムアウトに救われているだけなのかを切り分ける唯一の手掛かり」と位置づけているので、それが落ちるのは致命的。`outro()` の書き込みが後に続くのでほとんどの場合は間に合うが、ステップ 7 の手動確認手順に「ログをファイルにリダイレクトした状態でも警告が残ることを 1 回は確認する」を入れておくと安全。

- **[S-005]** タイムアウトで打ち切ったとき、**サーバーは listen したまま `shutdown()` が resolve する**。CLI は直後に `process.exit(0)` するので実害は無いが、テストから `shutdown()` を呼ぶ経路では危険。
  - 理由: `src/server/index.test.ts` の `afterEach` は `await server?.shutdown().catch(() => {})` だけで後始末を終えたことにしている。打ち切りが起きるとポートとソケットが握られたまま次のテストへ進み、vitest の teardown が終わらない / 後続テストが不定になる。ADR-001 の「`shutdown()` はテストから安全に呼べる」という主張はタイムアウト時には成り立たない。打ち切り時に `closeAllConnections()` をもう一度呼ぶ（副作用が無く冪等）か、`ServerInstance` の doc コメントに「タイムアウト時はリソースが残る。プロセスを終わらせる責務は呼び出し側」と明記すること。

- **[S-006]** ADR-005 で `close` / `sseCloseAll` を「未使用だから」削除する一方、同じく `src/` 内で未使用の `watcher` フィールドは残している（`grep` で確認: `ServerInstance.watcher` の外部利用はゼロ）。
  - 理由: 削除基準が「未使用」ではなく「未使用**かつ**誤用でハングを再現できる」であることを ADR-005 に明記すれば一貫する。あわせて、ADR-004（型述語）と ADR-005（API 縮小）はどちらも Issue #102 の受け入れ基準そのものではない改善であり、PR 説明でスコープの位置づけ（ADR-004 は親指示由来、ADR-005 は再発防止の付随）を書いておくとレビューが早い。

- **[S-007]** 「レースが成立しない」証明の書き方を、より頑健な理由に差し替えることを推奨する。
  - 理由: plan / ADR-001 は「Hono の `run` が同期呼び出しだから」を根拠に挙げているが、これは `/sse` がミドルウェア無しの**単一ハンドラマッチ**であるという現状に依存する（`hono-base.js:285` の fast path）。`app.use(...)` を 1 つ足すと `compose` 経路になりハンドラ呼び出しはマイクロタスク境界を跨ぐ。本質的な理由は「**マイクロタスクは次のマクロタスクの前に必ず全て流れるので、`request` イベントと SIGINT ハンドラという 2 つのマクロタスクが interleave しない**」であり、こちらならミドルウェアが増えても成立する。plan の結論は変わらないが、根拠を差し替えると将来の読者を誤らせない。

- **[S-008]** ステップ 7（手動確認）に「**報告者環境と同じ Node 24 系で再現を試みる**」を追加することを推奨する。
  - 理由: 本レビューでは Node 22.22.1 上で 8 種のシナリオ + 40 接続の再接続ストーム + 実 CLI への SIGINT 12 回を試して**一度も再現しなかった**。`closeAllConnections()` は全ケースで `_connections` を同期的に 0 にしている。残る最有力の変数が Node のバージョンであり、ここを潰さないまま「タイムアウトで直った」で閉じると真因が永久に埋もれる。Node 24 で `_connections` / `server.close()` の挙動を計測するだけなら 30 分程度の作業で済む。

- **[S-009]** シャットダウン各ステップにデバッグログ（または最低限、開始ログ）を入れることを検討する。
  - 理由: Issue の「SIGTERM で即座に終了した」という観測は、(i) SIGINT ハンドラが `await server.shutdown()` で停止 → SIGTERM が force exit 分岐に落ちた、(ii) **SIGINT ハンドラがそもそも起動していなかった** → SIGTERM で初めて正常終了した、の**両方と整合する**。plan は (i) だけを前提にしているが、(ii) を排除する証拠は無い。CLI は SIGINT 受信時に `intro(" Shutting down... ")` を出すので、次回再発時に「その表示が出たか」を記録するだけで切り分けられる。ステップ 7 の記録項目に「`Shutting down...` の表示有無」を明示的に入れておくとよい。

---

## 良い点

- **原因未特定を隠さずに設計の前提に据えた点が最大の美点。** 「レースを塞げば直る」という Issue の推定を鵜呑みにせず、実コードを読んで否定し（本レビューでも裏が取れた）、そのうえで「保証はタイムアウト、構造対策は再発防止」と役割を分けた ADR-001 の立て方は、この種の再現困難バグに対する正しい設計判断である。
- **`process.exit` をサーバー層に持ち込まない判断が正しい。** Issue の修正案 2 をそのまま採ると `src/server/index.ts` からプロセスを殺すことになり、層の責務違反かつテストからシャットダウンを呼べなくなる。「`shutdown()` はタイムアウト時も resolve し、プロセス制御は CLI 層の単独責務のまま」は既存構造（`process.exit` が `src/index.ts` にのみ存在）とも一致しており、`grep` でも裏が取れた。
- **「フラグ公開 → 走査 / 自己登録 → フラグ再チェック」パターンの選択と、その正しさの証明が的確。** 2 つの同期ブロックが interleave しないという議論は正しく、しかも「他所に `await` が無いこと」に依存しない。現状の安全性が偶然に依存していることを見抜いて構造へ移す、という動機付けも正しい。
- **`withTimeout` を切り出してテスト可能性を確保した判断が正しい。** 「実サーバーでは `close` が永久に解決しない状況を作れないので、この関数の単体テストが AC-1 を検証できる唯一の場所」という理由づけは的確で、実際に本レビューでも実サーバーでの再現は不可能だった。返り値を `Result` ではなく `TimeoutOutcome` にした理由（`TypedError` が `cause: Error` を必須にするが、タイムアウトはエラーではなく期待される分岐）も `src/core/error.ts` の実装と整合している。
- **`server.close()` を破棄操作より前に置く順序変更（ADR-002）は正しい。** 実害が出ていない現状でも、「破棄 → 再接続 → accept」という論理的に危険な順序を消しておくのは筋が良い。`closeIdleConnections()` を「`closeAllConnections()` の下位互換で、drain しない以上追加効果が無い」として不採用にした判断も正しい。
- **`closeAllConnections()` が省略不可という分析が正しく、しかもコードで裏が取れる。** Hono の `run()` の `finally { stream.close() }` は `StreamingApi.close()` → `writer.close()` であり、`@hono/node-server` 側で `writable.end()` に落ちて **HTTP レスポンスが正常終了 = ソケットは keep-alive のアイドル状態に戻る**（`streamSSE` は `Connection: keep-alive` を明示的に付けている）。「SSE ストリームを閉じるだけではソケットは解放されない」という plan の指摘はそのとおりである。
- **`isHttpServer` 型述語は実際にコンパイルが通る（検証済み）。** `ServerType = Server | Http2Server | Http2SecureServer` の `Server` は `node:http` の `Server` そのもの（`node_modules/@hono/node-server/dist/types.d.ts`）で、`ServerType` は `@hono/node-server` から型として export されている（`index.d.ts`）。`closeAllConnections` / `closeIdleConnections` が `@types/node` の `http.d.ts:463,469` にのみ存在し `http2.d.ts` には無いという plan の記述も正しい。実際に述語を書いて `pnpm typecheck`（tsgo）を通したところ、`if` 側の `http.Server` への narrowing も、`else` 側の `Http2Server | Http2SecureServer` への narrowing も**どちらもエラー無し**だった。`Http2SecureServer` との構造的互換性の問題も発生しない。
- **AC-3 のテスト（`shutdown()` を await せずに `fetch` が reject する）は実測で決定的だった。** `startServer` → 未 await の `shutdown()` → `fetch` を 40 回、および「SSE 接続を開いた状態で」同じことを 40 回、計 80 回試して**1 度も fetch が成功しなかった**。macOS の listen backlog による flaky は観測されていない。既存テスト `server does not accept connections after shutdown` と同じ経路なので、CI でも安定すると考えてよい。ただしこの決定性は「`shutdown()` の最初の `await` より前に `close()` が呼ばれる」ことに依存するので、その旨を実装側にコメントで残すことを推奨する（plan は既に順序に理由コメントを付ける方針なのでカバーされている）。
- **`broadcast()` への `shuttingDown` ガード追加は既存契約を壊さない。** `broadcast` の呼び出し元は `setupWatcher` 内の watcher コールバックのみで（`grep` 確認済み）、しかも `src/lib/watcher.ts` の `debounced()` は `closed` フラグと `clearTimeout` の二重で発火を止めている。新しい順序では `sse.shutdown()` → `watcher.close()` が同一同期ブロックなので、そもそも間に割り込む余地が無い。契約の明確化として無害かつ妥当。
- **`let shuttingDown` の追加は CLAUDE.md の原則と矛盾しない。** リポジトリは「ステートレスな純粋関数型スタイル」を掲げつつ、実際には `createFileWatcher` の `let closed`、`createSseManager` の `clients: Set`、`startServer` の `shutdownPromise` のように、**プロセス外資源のライフサイクルだけはクロージャに閉じ込めて `readonly` メソッド群を返すハンドル型**で表現している。`shuttingDown` はこのパターンの素直な延長であり、plan がそれを既存パターンとして明示している点も良い。
