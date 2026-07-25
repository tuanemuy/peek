# 計画レビュー Round 3（最終） — アーキテクチャ整合性・実現可能性・リスク

**Issue:** #102
**対象:** `.issue/102/plan.md` / `.issue/102/adr.md`
**視点:** あるべきアーキテクチャとの整合性 / 実現可能性 / リスク
**検証環境:** Node v22.22.1, macOS (Darwin 25.4.0), vitest 4.1.2, hono 4.12.10, @hono/node-server 1.19.14, tsgo 7.0.0-dev.20260404.1

本レビューも実測で裏を取っている。実施した検証: (1) 計画どおりの `withTimeout` / `isHttpServer` / `delay(..., {signal})` / `NodeJS.Signals` ハンドラを実際に `src/` 配下に置いて `pnpm typecheck`（tsgo）を通す、(2) `sse.ts` の 4 変種（現行 / `node:timers/promises` 版 / それぞれ abort 除去版）を作って AC-7・AC-8 のテストを実際に走らせる、(3) vitest 4.1.2 のバンドル済み fake-timers 実装（`node_modules/vitest/dist/chunks/test.p_J6dB8a.js`）を読み、`node:timers/promises` を差し替える経路の有無を実測、(4) AC-1 の `spawn` + 実 SIGINT レシピを計画記載のコマンドそのままで実行、(5) `unref()` 済みタイマーの挙動、シグナルハンドラとイベントループの関係。**検証用ファイルはすべて削除済み（`git status` でリポジトリがクリーンなことを確認）。**

---

#### 2周目指摘の解消状況

**アーキ視点（round-2-arch-risk.md）**

- [P-101]（stdio drain が exit code を 0→1 に変えうる） **解消** — 計画から完全に削除された。スコープ「含まれないもの」（plan L51）に実測値付きの撤回理由、ADR-007(1) に「採用しない（1 周目の決定を撤回する）」、ステップ 5 に「stdio drain は追加しない」と 3 箇所で一貫。終了パスに新たな `await` を足す変更はゼロになった。代替（`logger.warn` を `process.exit(0)` より前に呼ぶ順序の維持）と残存リスクも「リスクと注意点」に記載済み。
- [P-102]（AC-8 のテストが `sse.ts` を通らない） **解消** — AC-8 のテストが `createSseManager()` を経由する形に作り直された（plan L421-439）。**本レビューで両方向を再実測: 現行の手書き `sleep()` 版 max = 2（fail）/ `node:timers/promises` 版 max = 1（pass）、いずれも `clientCount = 1`。** 判別性は確かにある。ただし別方向の穴が残っている（→ P-201）。
- [S-101]（`timeoutMs <= 0` の特別扱いで AC-3 を自動化） **取り込み済み** — plan L169 / ステップ 1 / ADR-001 L47-58。手動確認頼みだった AC-3 が自動テストに昇格した。契約上の妥当性は下記「新規変更の検証 1」で評価（問題なし）。
- [S-102]（シグナル受信ログの挿入位置） **取り込み済み** — `console.log()` の後・`intro()` の前（plan L314 / ステップ 5 / ADR-007(3)）。後半（増分価値は限定的なので削除も可）は「見送った提案」として理由付きで明記（plan L580）。判断・記録とも妥当。
- [S-103]（再 `closeAllConnections()` を「効く」と書かない） **解消（提案以上）** — 「正直に無効果と書く」ではなく処理自体を削除した。ADR-007(2) に「効く場面が構成上存在しない」「無害でも実効ゼロの処理を保険として残すと将来の読者を誤らせる」と根拠を残したうえで、doc コメント（タイムアウト時はソケットハンドルが残りうる／プロセス終了の責務は呼び出し側）は維持。指摘の意図に対して最も筋の良い解。
- [S-104]（グループ A 単独マージ時の手動確認） **解消** — ステップ 9 冒頭に「グループ A 単独マージ時の最小手順」（起動 → タブ放置 → Ctrl+C ×3、終了時間と警告有無を記録）が定義された（plan L454-455）。
- [S-105]（「stderr が TTY でなければ非同期」の一般化しすぎ） **解消** — ADR-007 L369 に「ファイルは同期、TTY は POSIX で同期、pipe は macOS でのみ非同期」と訂正し、200KB 実測（pipe は 65536 で切断／ファイルは全量）と整合させている。
- [S-106]（落とすべきは P-101 / P-102 の 2 点のみ） **解消** — 2 点とも処理済みで、他は据え置き。スコープはむしろ 2 周目より縮んでいる。

**カバレッジ視点（round-2-coverage.md）**

- [P-101]（AC-7 が `closeAllConnections()` に救われて落ちない） **解消** — 検証層が `src/server/index.test.ts`（実ポート）から `src/server/routes/sse.test.ts`（`app.request`）へ移り、判定基準が「レスポンス body が 500ms 以内に EOF」に変わった（plan L29 / L420）。**本レビューで 4 変種を実測**（下記「新規変更の検証 2」）。判別性は確認できた。
- [P-102]（AC-8 が peek のコードを 1 行も通らない） **解消** — アーキ P-102 と同一。
- [S-101]（ステップ 4 をグループ B へ / AC-1 の対応ステップから外す） **解消** — シグナルログはステップ 5（グループ B 先頭）に移動し、AC-1 の対応ステップは 1・3・4（4 = 終了性テスト）になった。stdio drain 自体が消えたため、この指摘の主要因も消えている。
- [S-102]（プロセステストの運用詳細） **解消** — 起動コマンド・起動検出・空きポート・fixture・後始末・ビルド成果物をすべて確定（plan L369-375）。**本レビューで計画記載のコマンドをそのまま実行して再現: 起動 341ms / SIGINT→`close` 21ms / exit code 0 / `Server stopped. Bye!` まで出力。** `process.execPath` 直起動なので `child.kill("SIGINT")` は中間プロセスを介さず直接届く。実現性に問題なし。
- [S-103]（CI matrix の事実を明記） **解消** — `.github/workflows/ci.yml` を確認: `matrix.node-version: [22, 24]` × `ubuntu-latest` で `pnpm test`。plan L77 / L129 / ステップ 9 の記述は正確で、Node 24 手動確認を「macOS × 実ブラウザ ×3 回」に限定した整理も妥当。
- [S-104]（AC-2 が間接検証であることの明記） **解消** — AC 表 L24 とテスト方針「間接検証にとどまるもの」L509 の 2 箇所に、担保の内訳（`withTimeout` 単体テスト + `shutdown()` の唯一の待機点という構成）まで書かれている。AC-8 の限界も同じ粒度で併記。

**→ 2 周目の指摘 13 件はすべて解消。未解消・部分的なものは無い。** 反映のために入った新規変更のうち、新たな問題は P-201 の 1 件のみ。

---

#### 新規変更の検証（実測）

##### 1. `withTimeout(p, timeoutMs <= 0)` の「executor 内で同期 resolve」— **契約として一貫している。問題なし**

親レビュー指示にある「`timeoutMs > 0` のときは非同期なのに 0 以下だけ同期になる」という非対称性は、**呼び出し側からは観測できない**。Promise の resolve は executor 内で同期的に呼んでも、`then` / `await` への配送は必ずマイクロタスク経由になるため、`await withTimeout(p, 0)` も `await withTimeout(p, 2000)` も呼び出し側から見れば等しく非同期である。差は「いつ結果が確定するか」だけで、`shutdown()` の手順 1〜4（同期ブロック）が最初の `await` より前に完走する構造は `timeoutMs` の値に依存しない。したがって AC-4（`shutdown()` から戻った直後にリスナーが閉じている）も両方の経路で成立する。

実質的な意味論の差は 1 点のみ: **`timeoutMs <= 0` のとき、`promise` が既に解決済みでも `timed-out` を返す**（全関数として「予算ゼロ = 常にタイムアウト」を定義した）。これは ADR-001 L67 のトレードオフ欄に明記済みで、呼び出し箇所は `shutdown()` 1 箇所・既定値 2000ms なので実害はない。より素直な設計（例: `withTimeout` は純粋な race に留め、`shutdown()` 側でタイムアウト分岐だけをモジュールモックで検証する）も考えられるが、`vi.mock` による差し替えを持ち込むより現在の全関数定義の方が単純で、テストが実装を通る度合いも高い。**現行案を支持する。**

文言についてのみ 1 点（→ S-203）: 「同期的に resolve する」という書き方は上記のとおり呼び出し側の観測とずれるので、doc コメントとしては「`timeoutMs <= 0` は `promise` の settle 順序と無関係に決定的に `timed-out` を返す」と書く方が誤読されない。

なお計画どおりの `withTimeout`（`timer.unref()` 込み）・`isHttpServer` 型述語・`delay(KEEP_ALIVE_INTERVAL_MS, undefined, { signal })`・`(signal: NodeJS.Signals) => Promise<void>` を `process.on("SIGINT", ...)` に渡す形は、**実際に `src/` 配下に置いて `pnpm typecheck`（tsgo）がエラー 0 で通ることを確認した**（確認後に削除済み）。

##### 2. AC-7 を `sse.test.ts`（`app.request`、ソケット無し）に移した設計 — **判別性を実測確認。妥当**

`sse.ts` の 4 変種を作り、計画どおりの手順（`await app.request("/sse")` → 50ms 待機 → `getReader()` → `closeAll()` → `read()` を 500ms でレース）で実測した。

| 変種 | `clientCount` | `read()` の結果 |
|---|---|---|
| 現行（手書き `sleep()`）・abort あり | 1 | **`done: true` / 1ms** |
| 現行・`abortController.abort()` 除去 | 1 | **EOF 来ず（500ms 到達）** |
| `node:timers/promises` 版・abort あり | 1 | **`done: true` / 1ms** |
| `node:timers/promises` 版・abort 除去 | 1 | **EOF 来ず（500ms 到達）** |

`app.request` 経路にはソケットが無く `closeAllConnections()` に救われる余地が構造的に無い、という計画の主張どおり、**per-client abort を失うと必ず落ちる**。閾値 500ms に対して実測 1ms なので CI でのマージンも 2〜3 桁ある。keep-alive の実装を差し替えた後でも判別性が保たれることも確認できた（上表の 3・4 行目）。**この設計に問題は無い。**

##### 3. AC-8 が依存する「vitest fake timers はグローバル `setTimeout` を駆動するが `node:timers/promises` は駆動しない」非対称性 — **計画の主張は正しく、かつ計画が思っているより頑健。将来壊れても false pass にはならない**

vitest 4.1.2 のバンドル済み fake-timers 実装を読んだところ、**`node:timers/promises` の `setTimeout` / `setImmediate` / `setInterval` を差し替えるコードは実装として存在する**（`test.p_J6dB8a.js` の `clock.timersPromisesModuleMethods` 周辺）。ただし次の 2 層で無効化されている。

1. その差し替え対象 `timersPromisesModule` は `__vitest_required__.timersPromises` から取得されるが、**実際には差し替えが適用されていない。** 実測: テスト内で `globalThis.__vitest_required__.timersPromises`（`createRequire()("node:timers/promises")` と同一オブジェクトであることも確認）を掴み、`vi.useFakeTimers()` の前後で `setTimeout` の参照を比較したところ **変化なし（patched = false）**。当然そのオブジェクト経由で呼んでも `advanceTimersByTimeAsync(30_000)` では解決しない。
2. **仮に 1 が将来効くようになっても、`sse.ts` の `import { setTimeout as delay } from "node:timers/promises"` には届かない。** 実測: CJS 側の `exports.setTimeout` を直接差し替えたうえで、静的 import している別モジュール（vitest/Vite の変換を通したもの）から呼んでも、差し替え後の関数は呼ばれず元の実装が動いた。モジュールオブジェクトの mutation は静的 import の束縛に反映されない。

`toFake` の既定値も確認した: `Object.keys(clock.timers).filter(t => t !== "nextTick" && t !== "queueMicrotask")` で、対象はあくまで**グローバル**の timer API と `Date` 等である。`node:timers/promises` は「既定に含まれていない」のではなく、含めるための経路自体が上記 2 層で塞がれている。

**壊れた場合に false pass になるか fail になるかの判定:**

- 仮に将来 vitest が `node:timers/promises` を実効的に fake できるようになった場合、AC-8 のテストでは keep-alive ループが 5 周回る。vitest 側の差し替え実装は **解決時に abort リスナーを `removeEventListener` する**（バンドルを読んで確認）ので、待機中のリスナー数は常に 1 以下のまま。**正しい実装は pass のまま、手書き `sleep()` は 5 個以上に増えて fail のまま**で、回帰ガードとしての判別性は維持される。つまりこの非対称性が崩れても **false pass にはならない**。壊れるのは計画に書かれた「green になる理由」の説明（と ADR-006 のトレードオフ欄）だけである。
- **実際の false pass 経路はここではなく、アサーションの形にある（→ P-201）。**

##### 4. シグナル受信ログの挿入位置（`console.log()` の後・`intro()` の前）— **妥当**

`src/index.ts:178-179` は `console.log()`（空行）→ `intro(pc.bgYellow(...))` の順。ここに `logger.info()`（= `console.log("[peek]", ...)`）を挟むと、端末の `^C` エコー → 改行 → `[peek] Received SIGINT, shutting down...` → clack の `┌ Shutting down...` となり、`^C` との行連結も clack のバー描画（`intro` 〜 `outro` の枠）も壊さない。`intro()` の後に置くと枠内に素の `console.log` が混ざるので、この位置が正しい。`process.on("SIGINT", handler)` がハンドラ第 1 引数にシグナル名を渡す点、`(signal: NodeJS.Signals) => Promise<void>` が `process.on` の型を満たす点も typecheck で確認済み。

---

#### 問題点（要修正）

- **[P-201]** **AC-8 のテストは、`/sse` ハンドラが keep-alive の待機に到達しなかった場合に「何も検証せずに緑」になる（vacuous pass）。しかもその状態を作る変更は同じステップ 6 に含まれている。**
  - 理由: 計画のアサーションは `expect(Math.max(...counts)).toBeLessThanOrEqual(1);` のみ。`counts` は捕捉した全 `AbortSignal` のリスナー数だが、**そこには Hono 内部の `AbortController` が必ず混ざる**（実測でも `signals.length = 2`）。したがってクライアントがそもそも登録されない／keep-alive ループに入らない実装では `counts = [0, 0]` → `max = 0` → **アサーションを通過する**。
    実際に、ステップ 6 で追加する②の再チェック（`if (shuttingDown) { cleanup(); return; }`）が誤って常に真になる実装（= フラグの初期値ミスや条件の反転）を模して `/sse` ハンドラを即 return させた変種を作り、計画のテストをそのまま走らせたところ **`counts = [0, 0]` / `clientCount = 0` で PASS した**（本レビューで実測）。`Math.max(...[])` が `-Infinity` になるケースも同様に通る。
    2 周目までに 2 度潰した「構造的に落ちないテスト」（1 周目アーキ P-001、2 周目カバレッジ P-101 / P-102）と同じ系統の穴が、方向を変えて残っている。**AC-8 は「手書き `sleep()` の再導入を検出する回帰ガード」なのに、検出対象と無関係な実装バグで自動的に緑になる**のは受け入れ基準として成立していない。
  - 提案: アサーションの直前に **positive control** を 1〜2 行足す。実測で両方向を確認済み（正しい実装: `clientCount = 1` / `counts` に `1` を含む。上記の即 return 変種: `clientCount = 0` / `counts = [0, 0]`）。
    ```ts
    expect(sse.clientCount).toBe(1);            // ハンドラが keep-alive 待機まで到達したことの確認
    expect(counts).toContain(1);                // 待機中の abort リスナーが実在することの確認
    expect(Math.max(...counts)).toBeLessThanOrEqual(1);
    ```
    ステップ 7 の該当箇所と AC-8 の本文に「positive control を必ず伴う」旨を書き足すこと。差分はテスト 2 行で、他の設計判断には影響しない。

---

#### 改善提案（検討推奨）

- **[S-201]** `withTimeout` の `timer.unref()` は、計画が挙げている理由（「unref しないとタイムアウト時間だけイベントループが生き延び、テストの teardown が遅延する」）ではほとんど正当化されない一方、**タイムアウト時の観測性を失う経路**を持つ。実測: 未解決の Promise を相手にした場合、unref 済みタイマーは他に ref 付きハンドルが無いとそのまま**発火せずプロセスが自然終了する**（警告も `outro()` も `process.exit(0)` も走らない。exit code は 0）。ref 付きなら 300ms 後に発火して警告が出る。
  - ただし本 Issue の症状は「ハングする」＝ ref 付きハンドルが残っている状態なので、実際の再発時には unref 済みでもタイマーは発火し、警告は出る。害が出るのは「close コールバックが来ないのに ref 付きハンドルも無い」という別クラスの異常のみ。
  - 一方 `promise` が期限内に settle した場合は `clearTimeout` するので、ref のままでも teardown は遅延しない。**残す/外すどちらでも実害は小さいが、外す（ref のまま）方が AC-3 の観測性という計画の目的に素直**。実装時にどちらか選び、選んだ理由を doc コメントに 1 行残すこと。
- **[S-202]** `withTimeout` の分岐条件は `timeoutMs <= 0` ではなく `!(timeoutMs > 0)` にすると `NaN` も「予算ゼロ」に落ちる。現状 `NaN` は `<= 0` が false になるため `setTimeout(NaN)` 経路（≒ 1ms 後に発火）に落ちてしまい、意味論が曖昧になる。呼び出し元が 1 箇所なので実害は無いが、型で防げない入力に対する全関数化としては後者が素直（CLAUDE.md の型安全性志向とも整合）。
- **[S-203]** `withTimeout` の doc コメント / plan L169 の「executor 内で同期的に resolve する」という表現を、「`promise` の settle 順序と無関係に決定的に `timed-out` を返す」に言い換える。呼び出し側から見れば `await` は常に非同期であり、「同期 resolve」は誤読を招く（「同期関数として値が返る」と読まれうる）。実装方法の記述としては正しいので、実装メモとして併記するのは可。
- **[S-204]** AC-8 のテスト末尾（`finally` 内、`vi.useRealTimers()` の前）で `sse.shutdown()` を呼んで client を abort しておく。`node:timers/promises` 版は fake timers に駆動されないため、テスト中に張られた `delay(30_000)` は **ref 付きの実タイマー**として残る（`ref: true` が既定）。本レビューの実測では vitest のワーカー終了で回収され `vitest run` 全体は 1 秒未満で終わったので実害は確認できなかったが、1 行で確実に消せるゴミなので消しておく方がよい。

---

#### 良い点

- **2 周目で「テストがあることにしない」判断を 2 件とも作り直し、どちらも実測で判別性を確認してから計画に書いている。** AC-7（`app.request` 層への移設）と AC-8（`createSseManager()` 経由 + `AbortController` スパイ）は、本レビューで独立に再現したところいずれも主張どおりに落ちる／通る。特に AC-7 は「abort を消した複製で 500ms 経っても EOF が来ない」という**失敗方向の実測**まで取っており、回帰ガードとして機能することが確認できる形になっている。
- **stdio drain の撤回が、指摘の受け入れではなく再検証の結果として行われている。** 「exit code が 0→1 に変わる」「壊れるのは AC-3 の採取手順そのもの」「そもそも 1 行の書き込みは欠落しない（欠落は 64KB 超のみ）」という 3 段の実測を残したうえで削除し、残存リスクを「リスクと注意点」に明記した。**終了パスに新たな `await` を一切足さない**という結論は、本 Issue（終了性の不具合）の性質に照らして最も安全な着地点である。
- **再 `closeAllConnections()` の削除判断。** 「無害だから残す」ではなく「効く場面が構成上存在しない処理を保険として置くと将来の読者を誤らせる」という理由で消し、代わりに解消できない事実（タイムアウト時はソケットハンドルが残りうる）を doc コメントの契約として残した。無効なコードと有効な契約の切り分けが正確。
- **AC-8 の「証明する範囲」を AC 表直下・ステップ 7・テスト方針の 3 箇所に明記している。** 本レビューで fake-timers の実装まで読んだ結果、この非対称性は計画が書いているより頑健（差し替え経路が二重に塞がれている）で、かつ将来崩れても false pass にはならないことが分かった。計画の記述は保守的な側に倒れており、誤りではない。
- **AC-1 の運用詳細が、そのまま実行できる粒度まで確定している。** 記載のコマンド・ポーリング条件・後始末をそのまま写して走らせたところ、起動 341ms / SIGINT→`close` 21ms / exit 0 で再現した。実装者が詰まる余地がほとんど無い。
- **CLAUDE.md の原則との整合は維持されている。** `TimeoutOutcome<T>` の判別可能ユニオン（`TypedError` の `cause: Error` 必須という実装事実に基づく不採用理由まで含めて）、`isHttpServer` 型述語、`shuttingDown` を `createSseManager()` のクロージャに閉じ込めて `readonly` メソッド群を返すハンドル型パターンは、いずれも既存様式（`createFileWatcher` の `let closed`、`startServer` の `shutdownPromise`）の素直な延長。`process.exit` を CLI 層に留める判断もレイヤー責務と一致している。
- **グループ A（ステップ 1〜4）単独で Issue の要件が満たされることを最終確認した。** 要件は「SIGINT 1 回で有限時間終了」の 1 点で、これを担うのは `withTimeout` による有界化（ステップ 1・3）とその検証（ステップ 2・4）のみ。ステップ 3 は `sse.closeAll()` の呼び出し名を維持し `ServerInstance` の型も変えないため、`src/server/routes/sse.ts` 無変更・既存テスト無改修でビルドとテストが通る。グループ B（ステップ 5〜9）は全て再発防止・付随整理で、A の要件充足に必要な依存を持たない。**分割は掛け声でなく実際に成立している。**

---

#### 実装フェーズへの申し送り

- **最も「直すために入れた変更が新しいバグを生む」リスクが高いのはステップ 6（`sse.ts`）である。** 1 ファイルに (a) `closeAll` → `shutdown` 改名、(b) `shuttingDown` フラグ、(c) ルート入口の 503、(d) 登録直後の再チェック、(e) 手書き `sleep()` → `node:timers/promises`、(f) `.catch(cleanup)` の削除、の 6 変更が同時に入る。順序の制約（`shuttingDown = true` を**走査より前**、②の再チェックは `clients.add` と `stream.onAbort` の**直後**かつ keep-alive ループの**前**）を崩すとレース対策が無効化されるが、**それを検出するテストは AC-5/AC-6（503 と `clientCount`）しか無く、②の経路そのものを直接検証するテストは無い**（ワイヤ上は 200 + 即 EOF で、①の 503 と区別しにくいため）。②は目視レビューで担保するしかない箇所なので、コメントで意図を明示し、レビュー時にここを重点的に見ること。可能なら (e)(f) を (a)〜(d) と別コミットに分けると切り分けやすい。
- **P-201 の positive control は、まさにステップ 6 の②を壊したときに効く。** 先に入れておくこと。
- `shutdown(options)` の既定値は `options?.timeoutMs ?? SHUTDOWN_TIMEOUT_MS` とし、`{ timeoutMs: undefined }` が 0 や `NaN` に落ちないようにする（S-202 と合わせて全関数化しておく）。
- **`logger.warn` は必ず `outro()` / `process.exit(0)` より前に出す順序を保つ**（ADR-007 で drain を捨てた代替がこの順序だけである）。ステップ 3 でタイムアウト分岐に書く警告文は「どのくらい待って諦めたか」（= 実効 `timeoutMs`）を含めると、ステップ 9 の記録がそのまま真因追跡に使える。
- AC-8 のテストは `globalThis.AbortController` を差し替える。**必ず `try` / `finally` で復元し、`vi.useRealTimers()` と同じ `finally` に置く**こと（片方だけ復元されると同ファイルの後続テストが壊れる）。あわせて S-204 の後始末を入れる。
- AC-3 の `timeoutMs: 0` ケースは、`shutdown()` が resolve した後も `closing` が未決着のまま残る（設計どおり）。`afterEach` の `shutdown()` は memo 化により no-op になる点を理解したうえで、テスト末尾で SSE レスポンスの `body.cancel()` を忘れないこと。
- ステップ 4 の `spawn` テストは `process.execPath` 直起動なので `child.kill("SIGINT")` が中間プロセスを介さず届く（実測で確認）。`node_modules/.bin/tsx` 版に安易に戻さないこと。
- タイムアウト警告が実運用で出るかどうかは、ステップ 9 の記録でしか分からない。**「10 回とも警告なし」も「毎回警告あり」も等しく重要な観測結果**なので、出なかった場合も必ず記録して PR に残すこと（前者なら構造対策で足りていた、後者なら真因が生きたままタイムアウトに救われている、という真逆の結論になる）。
