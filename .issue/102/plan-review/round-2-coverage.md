# plan レビュー round-2 — 観点: Issue の要件カバレッジ・スコープ整合性

**対象:** `.issue/102/plan.md` / `.issue/102/adr.md`
**Issue:** #102（Ctrl+C でシャットダウンが無限ハングすることがある）
**レビュー日:** 2026-07-25
**検証環境:** Node v22.22.1 / macOS（本レビューは実コード実行で裏を取っている。使い捨てスクリプトはリポジトリに残していない）

## 前提（1 周目から不変）

Issue から読み取れる要件は「`Ctrl+C`（SIGINT）を 1 回押したら、SSE 接続中でも peek プロセスが有限時間で終了すること」の 1 つだけ。修正案 1〜3 は手段の候補。以下の判定はすべてこの 1 要件を基準にしている。

---

#### 1周目指摘の解消状況

**カバレッジ視点（round-1-coverage.md）**

- [P-001] **解消** — AC-5 が「シャットダウン開始後に届いた `/sse` は SSE ストリームを一切開始せず 503 を返す（`sse.app.request("/sse")` の `status` と `content-type` で検証）」というサーバー側で検証可能な事実に書き換わっている（plan L27）。`clientCount` の話は AC-6 に分離済み。503 の採用理由も ADR-003 で「意味論的に正しいステータス / ストリームを生成しないので軽い」の 2 点に差し替わり、「非 2xx なら再接続しない」という誤った根拠は撤回されている（adr L135-140）。ステップ 9 の目視項目も「再試行が最大 10 回で止まり無限に続かないこと」に修正済み（plan L422）。文言だけでなく根拠の差し替えまで到達している。
- [P-002] **解消** — `src/server/renderer/html-document.tsx` が関連ファイル表に追加され、「Issue 本文が引用している `var es = new EventSource("/sse");` はこちらのコード」と明記されている（plan L64）。実ファイルを確認したところ `html-document.tsx:21` が `var es = new EventSource("/sse");`、`src/client/lib/sse.ts:40` が `const evtSource = new EventSource("/sse")` で、記述は正しい。スコープの「含まれないもの」も両実装を名指しする形になっている（plan L48）。
- [P-003] **解消** — AC 表を作り直したうえで、AC ↔ ステップの対応を全 10 行突き合わせた結果、不整合は無い（AC-1→1,3,4,5 / AC-2→1,2,3 / AC-3→3,4,9 / AC-4→3,5 / AC-5→6,7 / AC-6→6,7 / AC-7→3,5 / AC-8→6,7 / AC-9→5,7 / AC-10→9）。ステップ側の記述とも突き合わせ済み。テスト方針の表にも AC 列が入った。唯一議論の余地があるのは AC-1 の「4」だけ（→ S-101、軽微）。
- [P-004] **解消** — AC-1 としてプロセスレベルの基準（SIGINT 1 回 → 5 秒以内 / exit code 0）が新設され、ステップ 5 に `spawn` + 実 SIGINT の自動テストが入っている。**本レビューで実際に成立することを実測確認した**（下記「AC-1 テストの実現性検証」）。
- [P-005] **解消** — AC-10 の閾値が 5 秒（= `SHUTDOWN_TIMEOUT_MS` 2 秒 + オーバーヘッド）に修正され、閾値の導出も明記された（plan L36）。加えて「n=10 の成功は稀事象が直った証明にならない（発生率 1% なら 10 連続成功の確率は 90%）」という限界と、AC-10 の役割を非退行確認 + 観測に限定する記述が AC 表直下に入っている（plan L34）。
- [S-001] **解消** — 型述語化は AC から外れ、スコープ「含まれるもの（付随整理）」に降格。「`in` のままでも typecheck は通るため、変更前後で常に真になる条件しか書けない」という理由まで書かれている（plan L42、adr L206）。
- [S-002] **解消** — ADR-005 がスコープ「含まれるもの（付随整理）」に明記され、`sseCloseAll` の削除は ADR-003 の帰結、`close` の削除は誤用経路の除去、と性質の違いも書き分けられている（plan L43）。
- [S-003] **解消** — ステップ 6 に「**`broadcast()` への `shuttingDown` ガードは追加しない**」と明記され、対応テストも消えている（plan L388）。契約は doc コメントで示す方針。
- [S-004] **解消** — 「グループ A: 要件充足」「グループ B: 再発防止・付随整理」に分割され、順序を逆にしない旨も書かれている（plan L315-319, L375）。実際に独立コミット可能かは下記「グループ分割の妥当性」で検証済み。
- [S-005] **解消** — ADR-002 に「修正案 3 の後半は順序変更で解消される。不採用なのは `closeIdleConnections()` の併用のみ」という段落が入っている（adr L86）。
- [S-006] **解消** — AC-7 の由来が「回帰防止（既存の per-client abort の維持）」に、AC-4/5/6 が「再発防止（Issue 修正案 1）」に修正されている。
- [S-007] **解消** — `src/lib/` に置く根拠が「`timer.unref()` が Node 専用 API で `src/core/` のランタイム非依存要件を満たさない」に差し替わり、「`src/core/` はクライアントバンドルに入りうるから」という誤った根拠は明示的に撤回されている（plan L162、adr L47）。`src/client/lib/sse.ts:7` が `../../lib/logger.js` を import している事実も確認済み。

**アーキ視点（round-1-arch-risk.md）— plan が「すべて取り込んだ」と書いているため併せて検証**

- [アーキ P-001]（AC-6 テストが構造的に落ちない） **部分的** — 「タイムアウトに救われる」問題は `timeoutMs: 20_000` の注入と 500ms 閾値で解消した。しかし**別の理由で依然として落ちないテスト**である（→ P-101）。
- [アーキ P-002]（3 層 → 2 層 / `.catch(cleanup)` の扱い） **解消** — 2 層に訂正、`stream.write` 側は削除・`writeSSE` 側は残す、と方針が明記された（plan L223、adr L149-151）。永久 pending の可能性もリスク節に記載。
- [アーキ P-003] **解消**（カバレッジ P-001 と同一）。
- [アーキ P-004]（`sleep()` のリーク） **解消**（方針として） — ADR-006 が新設され、スコープにも含まれている。ただし**検証手段（AC-8 のテスト設計）が成立していない**（→ P-102）。
- [アーキ S-001〜S-009] **すべて解消** — S-001（`timeoutMs` を実テストで使う）/ S-002（配置根拠）/ S-003（②は 200 + 即 EOF）/ S-004（stdio drain）/ S-005（打ち切り時の再 `closeAllConnections` + doc コメント）/ S-006（削除基準の明文化）/ S-007（マイクロタスク論拠への差し替え）/ S-008（Node 24 での確認）/ S-009（シグナル受信ログ）がいずれも plan / adr の本文に反映されている。

---

#### 問題点（要修正）

- **[P-101]** AC-7 のテストは、1 周目の修正後も**主張している内容を検証できない**（今度は「タイムアウトに救われる」ではなく「`closeAllConnections()` に救われる」）。
  - 理由: AC-7 は「`shutdown({ timeoutMs: 20_000 })` 注入下でも 500ms 未満で解決する（= per-client abort でループが抜けている）」と書いているが、`server.close()` の解決は keep-alive ループが抜けるかどうかに依存しない。ソケットを destroy するのは `closeAllConnections()` であり、これは同期的に `_connections` を 0 にする。本レビューで peek と同形のシャットダウン手順（plan ステップ 3 の新順序）を実装し、**per-client abort を取り除いた版**で計測した結果:

    | 条件 | `server.close()` の解決 | streamSSE コールバックが返ったか |
    |---|---|---|
    | per-client abort あり（現行相当） | 2ms | 返った |
    | **per-client abort なし** | **0ms** | **返っていない（30 秒の sleep 継続中）** |

    つまり `abortController.abort()` を丸ごと削除しても AC-7 のテストは緑のままである。ADR-003 が「主: per-client abort」と位置づけている保証（keep-alive の 30 秒を待たずにループが抜ける）は、`server.shutdown()` の所要時間からは原理的に観測できない。これは 1 周目アーキ P-001 と同型の欠陥（「構造的に絶対落ちないテスト」）が、別の原因で残っている状態である。
  - 提案: AC-7 の検証層を `src/server/index.test.ts`（実ポート）から `src/server/routes/sse.test.ts`（Hono `app.request`）へ移す。`app.request` 経路にはソケットが無いため、`closeAllConnections()` に救われる余地が構造的に無い。

    ```ts
    // AC-7（改）: shutdown() 後、既存の SSE レスポンスが keep-alive 間隔を待たずに EOF に達する
    const res = await sse.app.request("/sse");
    await new Promise((r) => setTimeout(r, 50));
    const reader = res.body!.getReader();
    sse.shutdown();
    const { done } = await reader.read();   // per-client abort が無いと 30 秒返らない
    expect(done).toBe(true);
    ```

    本レビューで実測して判別可能性を確認済み: **現行実装（abort あり）は `closeAll()` 直後 0ms で `done: true`**、**abort を除去した版は 1000ms 経っても `read()` が解決しない**。あわせて AC-7 の由来欄（回帰防止）と対応ステップを 6, 7 に付け替えること。`server.shutdown()` 層に何か残したい場合は、「500ms 未満で解決する」ではなく「`timeoutMs: 20_000` 注入下でもタイムアウト警告が出ない」程度の主張に弱めるのが正確。

- **[P-102]** AC-8 のテスト（ステップ 7）は、**peek のコードを 1 行も通らない**ため受け入れ基準として成立していない。
  - 理由: plan L400 は「`node:timers/promises` の `setTimeout` を短い間隔で N 回正常完了させ、`getEventListeners(signal, "abort").length` が 0 のままであることを直接 assert する」「実装が手書き `sleep()` に戻れば落ちる」と書いているが、このテストが検証しているのは Node 標準ライブラリの挙動であって `src/server/routes/sse.ts` ではない。`sse.ts` が手書き `sleep()` に戻っても、このテストは緑のままである（テスト対象を import すらしていない）。ADR-006 が「実装が手書き `sleep()` に戻れば落ちる」と書いている検証は、この設計では成立しない。
  - 提案: `createSseManager()` を実際に経由する形にする。keep-alive の 30 秒はフェイクタイマーで送れる（`vi.advanceTimersByTimeAsync` が `node:timers/promises` を進められることは planner 自身が確認済み）。client 側の `AbortController` はクロージャ内で外から取れないので、生成をスパイして signal を捕まえる。

    ```ts
    const signals: AbortSignal[] = [];
    const Orig = globalThis.AbortController;
    class Spy extends Orig { constructor() { super(); signals.push(this.signal); } }
    globalThis.AbortController = Spy as typeof AbortController;
    try {
      vi.useFakeTimers();
      const sse = createSseManager();
      sse.app.request("/sse");
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(30_000);
      const counts = signals.map((s) => getEventListeners(s, "abort").length);
      expect(Math.max(...counts)).toBeLessThanOrEqual(1); // 待機中の 1 個は正常
    } finally { vi.useRealTimers(); globalThis.AbortController = Orig; }
    ```

    本レビューでこのテストを実際に書いて両方向を確認済み: **現行実装（手書き `sleep()`）で `2` になり fail**、**`node:timers/promises` に置き換えた複製モジュールで `1` になり pass**。`signals` には Hono 内部の `AbortController` も混ざるため `signals[0]` 決め打ちにせず全 signal の最大値を見ること（`signals[0]` は Hono 側で常に 0 になる）。
    これを入れられない場合は、AC-8 を受け入れ基準から外して「ADR-006 は手書きヘルパの削除であり、自動テストではなくコードレビューで担保する」とテスト方針に明記すること（自動化されていない基準を自動化済みのように書かないこと）。

---

#### 改善提案（検討推奨）

- **[S-101]** ステップ 4（CLI の観測性強化 + stdio drain）をグループ A から外し、グループ B の先頭（または A 内の独立コミット）に置く。あわせて AC-1 の対応ステップから「4」を外す。
  - 理由: グループ分割の趣旨は「Issue の要件はグループ A だけで満たされる」（plan L315）だが、ステップ 4 の内容（シグナル受信ログ + stdio drain）は要件充足に不要な観測性の追加であり、AC-1 は 1・3・5 だけで成立する。むしろ drain は `process.exit(0)` の手前に最大 200ms の待機を足すので、要件（速やかな終了）に対しては純粋なコストである（有界なので害は無いが、A に入れる理由にはならない）。ステップ 4 を B に置いても AC-3 の手動記録（ステップ 9）は成立する。分割の原則を自分で崩さない方が、PR 説明の主従関係の説明とも一貫する。

- **[S-102]** ステップ 5 のプロセステストの運用詳細（起動完了の検出 / 空きポート / fixture / 失敗時の後始末 / 実行方法）を plan に書き込む。実測データを添える。
  - 理由: 「起動を待ってから」としか書かれておらず、実装者が最も詰まる部分が未定のまま。本レビューで実際に動かして得た数値と選択肢は次のとおり（Node 22.22.1 / macOS）。

    | 起動方法 | 起動完了まで | SIGINT → `close` | exit code |
    |---|---|---|---|
    | `node_modules/.bin/tsx --import ./src/loaders/css.mjs src/index.ts <dir> --port <free> --no-open` | 488ms / 491ms | 45ms / 49ms | 0 |
    | `node --import ./src/loaders/css.mjs --import tsx/esm src/index.ts …` | 327ms | 11ms | 0 |

    - **どちらも成立する。** `tsx` バイナリは子プロセスを挟むが SIGINT を正しく転送し exit code 0 を伝播した。ただしラッパーを挟まない後者の方がシグナル配送経路が単純で、CI での不確実性が小さい。少なくとも「どちらでもよい」ではなく plan で 1 つに決めておくこと。
    - 起動完了の検出は「`fetch(http://localhost:<port>/)` が 200 を返すまで 150ms 間隔でポーリング（上限 20 秒）」で安定した。stdout の文言（`Server started`）に依存すると @clack の装飾・非 TTY 挙動に引きずられるので避ける。
    - 空きポートは既存の `getFreePort()`（`src/server/index.test.ts:12-21`）と同じ実装でよい。新規テストファイルからも使うなら共有ヘルパへの切り出しを検討する（複製でも可、ただし plan にどちらか明記）。
    - fixture は既存テストと同じく `mkdirSync` + `writeFileSync` で作る（ディレクトリモードなら `README.md` 1 つで足りる）。ディレクトリモードは `initMarkdown()`（shiki）を通るぶん起動が遅いが、上表のとおり 500ms 程度で `testTimeout: 30000` の枠には十分収まる。
    - **ビルド成果物は追加要件にならない。** CLI が要求する `src/server/renderer/global.css` / `client-bundle.js` / `favicon.js` は `pretest` が生成する。既存の `src/server/index.test.ts` も同じ成果物に依存しているため、`pnpm test` 経路では新たな前提は増えない。
    - 失敗時に子プロセスが残らないよう、`close` を待つ Promise にタイムアウトを付け、超過時は `child.kill("SIGKILL")` する後始末を明記すること（現状の記述には無い）。SSE を張るのに使った `fetch` レスポンスは `body.cancel()` する旨は既に書かれている。

- **[S-103]** 「CI マトリクスが ubuntu × Node 22 / 24 で `pnpm test` を回す」という事実を plan に書き、ステップ 9 の Node 24 手動確認の位置づけを整理する。
  - 理由: `.github/workflows/ci.yml` の matrix は `node-version: [22, 24]`。したがって AC-1 のプロセステスト（`spawn` + 実 SIGINT）は**自動で Node 24 上でも実行される**。真因の最有力候補が Node バージョン差である以上、これは計画にとって有利な事実であり、明記しておく価値がある。ステップ 9 の Node 24 手動確認は「実ブラウザ + 実 Ctrl+C + ログ観測」に限定でき、負担を減らせる（OS が macOS ではなく Linux である点は残るので、手動確認自体を無くす提案ではない）。

- **[S-104]** AC-2 の検証根拠を AC 表かテスト方針に 1 行で明示する。
  - 理由: AC-2 は「`shutdown()` は `server.close()` が永久に解決しない場合でも必ず有限時間で settle する」だが、自動検証はステップ 2 の `withTimeout` 単体テストであり、`shutdown()` そのものにその状況を注入するテストは存在しない（実サーバーでは作れないため妥当な判断）。つまり AC-2 は「`withTimeout` の単体テスト + `shutdown()` が唯一の待機点でそれを使っているというコード上の構成」で担保される。AC-3 については「手動確認のみ」と正直に書いてあるのだから、AC-2 についても「間接検証である」ことを同じ粒度で書いておくと、受け入れ判定時に誤読されない。

---

#### スコープ判定（親指示 5・6 への回答）

**膨張しているか: していない。落とすべきものは無い（配置だけ S-101）。** ステップ 7→9・AC 9→10・ADR 5→7 の増分を 1 件ずつ見た結果:

| 増分 | 判定 |
|---|---|
| ステップ 5 のプロセステスト / AC-1 | **必須。** Issue の唯一の要件を初めて回帰テスト化する。むしろ 1 周目に無かったのが問題だった |
| ADR-006（`sleep()` リーク修正）/ AC-8 | **妥当。** 変更対象そのものの中にある唯一の実測欠陥で、差分はヘルパ削除 + 1 行。グループ B に隔離されている |
| ADR-007(1)（stdio drain） | **境界。** 要件充足には不要だが、AC-3 の警告ログが真因切り分けの唯一の手掛かりであるという前提を守るための最小限の措置。落とすほどではないが、グループ A に置く理由は無い（S-101） |
| ADR-007(3)（シグナル受信ログ） | **妥当。** 1 行。真因未特定という前提から逆算した観測手段で、費用対効果が高い |
| ADR-004 / ADR-005（型述語化・API 縮小） | **妥当。** どちらも AC を伴わず「付随整理」と明記され、グループ B に隔離されている |

**逆方向（漏れ）: 無い。** Issue の要件・修正案 1〜3・2 回目 Ctrl+C の force exit・SIGTERM の扱いはすべて AC かスコープ記述で追跡されている。

**グループ分割の妥当性: 妥当。独立コミット可能。** コードを突き合わせて確認した。

- グループ A 単体でビルドが通る: ステップ 3 は `sse.closeAll()` の呼び出し名を変えない旨が明記されている（plan L350）。`src/server/routes/sse.ts` は無変更で成立する。
- グループ B 単体でビルドが通る: ステップ 6 に「改名に伴い `src/server/index.ts` の 2 箇所（listen エラー時 / `shutdown()` 内）を追随させる」と明記されている（plan L389）。ステップ 8 の `ServerInstance` 縮小もテストが `shutdown` しか使っていないため独立して着地できる。
- 順序も正しい（A → B）。B で回帰が出ても要件充足分が残る。

---

#### 良い点

- **1 周目の指摘が文言の言い換えではなく、根拠と構造の差し替えとして反映されている。** 特に P-001 は「AC の文を直す」で済ませず、503 の採用理由（ADR-003）・依存関係節・UI 節・手動確認の目視項目まで一貫して書き換えている。S-007 も「誤った根拠を採らない」と撤回理由を残しており、将来の読者が同じ誤りに戻らない形になっている。
- **AC-1（プロセスレベル）の追加が計画の性格を変えた。** 本レビューで実際に `spawn` + 実 SIGINT を回したところ、SSE 接続を張った状態で 45ms / exit code 0 で終了した。Issue の唯一の要件が初めて自動回帰テストになる。しかも CI の matrix により報告者環境と同じ Node 24 でも自動実行される。
- **要件と再発防止の主従が全編で一貫している。** 「目的」節の前提、AC の由来欄、スコープの「含まれるもの（付随整理）」、グループ A/B 分割、ADR-001 の Decision、リスク節、PR 説明への指示まで、同じ主従関係が繰り返し書かれていて崩れが無い。真因未特定を隠さずに設計の前提に据えた 1 周目の美点が維持されている。
- **AC-10 の限界（n=10 の証明力）を AC 表の直下に書いた判断。** 受け入れ基準の隣に「これは証明ではない」と書くのは勇気が要るが、後で「10 回通ったから直った」と誤読されるのを防ぐ最も効果的な位置にある。
- **グループ B が本当に独立コミット可能な粒度になっている。** 改名の追随先まで plan に列挙されているため、分割が「掛け声」で終わっていない。
- **ADR-006 / ADR-007 の判断が実測に基づいている。** リスナー 25/25 → 0、ポートは `server.close()` 呼び出し時点で解放、`timeoutMs: 0` では close コールバックが先に流れる、など「やってみて確かめた」事実で設計が支えられており、レビュー側も追試しやすい。
