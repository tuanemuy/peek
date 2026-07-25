# 動作確認計画 — Issue #102: Ctrl+C でシャットダウンが無限ハングすることがある

**Issue:** #102
**作成日:** 2026-07-25

---

## 確認環境

この Issue の変更を確認するために必要な手順のみ記載（プロジェクト全体のセットアップは省略）。

本 Issue は **CLI プロセスのシャットダウン挙動**の修正である。したがって確認の本体は「ブラウザで SSE 接続を張った状態のまま、peek プロセスに SIGINT を 1 回送って有限時間で終了するか」という**プロセス操作**であり、ブラウザは「実際に SSE 接続を保持する負荷源」として使う。

### 検証環境の起動

**推奨（既定）: ビルドして `dist/index.mjs` を直接起動する。**

```bash
pnpm build
node dist/index.mjs . --host 0.0.0.0 --port 3009
```

- `pnpm build` は `package.json` の `scripts.build`（`build:css && build:client && build:favicon && tsdown`）。実行確認済み（`dist/index.mjs` 128.39 kB が生成される）。
- `dist/index.mjs` は `package.json` の `bin.peek` の実体そのものなので、Issue の再現条件 `peek . --host 0.0.0.0 --port 3009` と**同一の実行形態**になる。
- `node` を直接呼ぶため **peek は単一プロセス**で、Ctrl+C / exit code をそのまま観測できる。実行確認済み（起動 → `GET /` が 200 → SIGINT → `Server stopped. Bye!` → exit code 0）。

**ソースを直接いじりながら確認する場合の代替（フルビルド不要）:**

```bash
pnpm build:css && pnpm build:client && pnpm build:favicon
node --import ./src/loaders/css.mjs --import tsx/esm src/index.ts . --host 0.0.0.0 --port 3009
```

- 生成物 3 点（`src/server/renderer/global.css` / `client-bundle.js` / `favicon.js`）は `.gitignore` 済みだが `src/server/renderer/document.tsx` が import するため起動に必須。生成コマンドは `package.json` の `scripts.build:css` / `build:client` / `build:favicon`。
- 起動形式は plan.md ステップ 4 のプロセステストが使うものと同一。実行確認済み（`GET /` 200、`GET /sse` が `200 text/event-stream`、SIGINT で正常終了）。

**使わない起動方法とその理由:**

- **`pnpm dev` は使わない。** `package.json` の定義は `pnpm dev:css & trap 'kill %1 2>/dev/null' EXIT; pnpm dev:server` で、postcss の watch を**バックグラウンドジョブとして並行起動し `trap` で kill する複合コマンド**である。Ctrl+C はフォアグラウンドプロセスグループ全体（postcss / pnpm ラッパー / node）に届くため、「peek プロセスが SIGINT を受けてから終了するまで」を分離して観測できず、シェルの `$?` も peek の exit code にならない。本 Issue の確認対象そのものを濁すので不適。
- **`pnpm dev:server` / `pnpm start` も使わない。** どちらも pnpm のラッパープロセスを 1 段挟むため、`$?` が peek ではなく pnpm の終了状態になる。上記 2 つの起動方法はいずれもラッパーを挟まない。

**HTML ファイルモード（第 2 の SSE クライアント実装）を確認する場合の対象ファイル:**

```bash
node dist/index.mjs testdata/html/01-basic-structure.html --host 0.0.0.0 --port 3009
```

`src/server/renderer/html-document.tsx` のインラインスクリプト（Issue 本文が引用している `var es = new EventSource("/sse");` のコード）が載るのはこのモード。ディレクトリモードで載るのは `src/client/lib/sse.ts` 側なので、**2 実装とも確認する必要がある**。

### SIGINT の送り方（2 通りを使い分ける）

| 方法 | 誰が実行するか | 再現するもの | 再現しないもの |
|---|---|---|---|
| 対話端末で実際に `Ctrl+C` を押す | 人間 | 端末の `^C` エコーとの行連結、clack の枠描画、プロセスグループ配送 | — |
| `kill -INT <pid>` | ブラウザ自動化エージェント / スクリプト | 終了性・exit code・警告ログ | `^C` エコー、プロセスグループ配送 |

**ブラウザ自動化エージェントが実行する場合の計測レシピ**（実行確認済み。`python3` は本環境に無いので `node -e` でタイムスタンプを取る）:

```bash
node dist/index.mjs . --host 0.0.0.0 --port 3009 --no-open > /tmp/peek-102.log 2>&1 &
BG=$!
# ここでブラウザから http://localhost:3009 を開き、SSE 接続が張られた状態にする
S=$(node -e 'process.stdout.write(String(Date.now()))')
kill -INT $BG
wait $BG
CODE=$?
E=$(node -e 'process.stdout.write(String(Date.now()))')
echo "exit=$CODE elapsed=$((E-S))ms"
grep -n "did not close within\|Received SIG" /tmp/peek-102.log
```

- `elapsed` には `node -e` の起動コスト（数十 ms）が乗るため、ミリ秒単位の精密計測ではなく「5 秒以内か」の判定に使う。実測例: SSE 接続 1 本ありで `exit=0 elapsed=42ms`。
- 自動 open された `http://0.0.0.0:3009` がブラウザで開けない場合は `--no-open` を付け、`http://localhost:3009` へ手動で遷移する（バインドは `0.0.0.0` のままで Issue の再現条件を満たす）。
- 警告文の検索キーは `did not close within`（実装の出力は `[peek] HTTP server did not close within 2000ms — ...`）。文言が変わっていても取りこぼさないよう、**`[peek]` プレフィックス付きの「期限内に close しなかった」旨の警告行**が出ていないかを目視でも確認する。

### デプロイ方法

なし（ローカル CLI の動作確認のみで完結する）。

## 確認項目

### 1. ディレクトリモードで SSE 接続中に Ctrl+C 1 回 → 有限時間で終了する

- **対応する受け入れ基準:** AC-1 / AC-10
- **目的:** Issue の唯一の要件（Ctrl+C 1 回で必ず終了する）が、実ブラウザ・実端末・実 SIGINT の条件で満たされること。自動テスト（`spawn` + `child.kill`）が再現できない TTY / 実ブラウザの条件を埋める。
- **手順:**
  1. `pnpm build` を実行する。
  2. 対話端末で `node dist/index.mjs . --host 0.0.0.0 --port 3009` を起動する。
  3. ブラウザで `http://localhost:3009` を開く。DevTools の Network タブを開き、`/sse` のリクエストが **pending（進行中）**のままであることを確認する（= SSE 接続が実際に張られている）。
  4. そのままタブを開いた状態で 1〜2 分放置する（keep-alive を数周させる）。
  5. 端末に戻って `Ctrl+C` を **1 回だけ**押す。押した時刻を記録する。
  6. `Server stopped. Bye!` が出てプロンプトが戻ったら、すぐに `echo $?` を実行する。
  7. 手順 2〜6 を **10 回**繰り返す。
- **期待結果:**
  - 毎回 `Shutting down...` の枠が出て、**5 秒以内**に `Server stopped. Bye!` が出て終了する。
  - `echo $?` が **0**。
  - 端末がハングしたまま戻らない回が **0 回**。
- **確認ポイント:**
  - **10 回すべての「所要時間」と「タイムアウト警告の有無」を記録して PR に残す**（plan.md ステップ 9）。「毎回警告なし」と「毎回警告あり」は真逆の結論（前者＝構造対策で足りていた／後者＝真因が生きたままタイムアウトに救われている）になるため、警告が出なかった場合も必ず記録する。
  - `^C` のエコーと `[peek] Received SIGINT, shutting down...` が同じ行に連結していないこと（`console.log()` による空行が保たれていること）。
  - clack の枠（`┌ Shutting down...` 〜 `└ Server stopped. Bye!`）が崩れていないこと。ただし**タイムアウト警告が出た試行では、枠の内側に警告行が 1 行割り込むのが正常**である。警告は clack ではなく `logger.warn`（`console.warn`）で出力するため枠線を持たず、次のような見え方になる。
    ```
    ┌   Shutting down...
    [peek] HTTP server did not close within 2000ms — ...
    │
    └  Server stopped. Bye!
    ```
    **この割り込みは FAIL ではない**（観測性を優先した設計上の挙動）。枠の崩れとして扱うのは、警告行以外の理由で `┌` / `│` / `└` の並びが失われている場合のみ。ただし**警告が出たこと自体は重大な観測結果**なので、上記のとおり必ず記録する。

### 2. HTML ファイルモード（第 2 の SSE クライアント実装）で同じ確認

- **対応する受け入れ基準:** AC-1 / AC-10
- **目的:** SSE クライアントは `src/client/lib/sse.ts`（Preact 側）と `src/server/renderer/html-document.tsx` のインラインスクリプトの **2 実装**あり、Issue 本文が引用しているのは後者である。ディレクトリモードだけでは後者を一度も通らない。
- **手順:**
  1. `node dist/index.mjs testdata/html/01-basic-structure.html --host 0.0.0.0 --port 3009` を起動する。
  2. ブラウザで `http://localhost:3009` を開き、DevTools Network で `/sse` が pending であることを確認する。
  3. 1〜2 分放置してから `Ctrl+C` を 1 回押す。
  4. 手順 1〜3 を **3 回**繰り返す。
- **期待結果:** 項目 1 と同じ（5 秒以内・exit code 0・ハング 0 回）。
- **確認ポイント:** HTML はプレビュー用 iframe に隔離されて描画されるが、SSE 接続はホスト側ドキュメントが張る。iframe ではなく**トップレベルドキュメント**の Network に `/sse` が出ていることを確認する。

### 3. 複数タブ・長時間放置後の終了

- **対応する受け入れ基準:** AC-1 / AC-10
- **目的:** Issue の症状プロファイル（「ブラウザタブを長く開いているほど踏みやすい」「`--host 0.0.0.0` で複数クライアント」）に最も近い条件で非退行を確認する。ADR-006 が解消した abort リスナーリークは keep-alive 30 秒周期で蓄積するため、放置時間が効く唯一の条件でもある。
- **手順:**
  1. `node dist/index.mjs . --host 0.0.0.0 --port 3009` を起動する。
  2. 同じ URL を **3 タブ**開く（各タブが独立した `/sse` 接続を張る）。DevTools でそれぞれ pending であることを確認する。
  3. **10 分以上**放置する（keep-alive を 20 周以上させる）。
  4. `Ctrl+C` を 1 回押す。
- **期待結果:** 5 秒以内に `Server stopped. Bye!` が出て exit code 0 で終了する。タブ数・放置時間に比例して遅くならない。
- **確認ポイント:** 放置中に各タブの `/sse` が pending のまま維持されていること（途中で切れて再接続を繰り返していると「長時間 SSE 接続を保持した状態」の確認になっていない）。

### 4. シャットダウン後のブラウザ側の再接続挙動（DevTools Network）

- **対応する受け入れ基準:** AC-5 / AC-7 の実機側の帰結 / AC-10
- **目的:** サーバー停止に対してクライアントが (i) keep-alive の 30 秒を待たずに切断を検知し、(ii) 無限に再接続し続けないこと。自動テスト（`sse.test.ts`）はサーバー側の 503 と body の EOF までしか見ない。**「実ブラウザの `EventSource` が実際にどう振る舞うか」はここでしか確認できない。**
- **手順:**
  1. 起動してブラウザで開き、DevTools の Network タブを開いたままにする（Preserve log を ON にする）。
  2. `/sse` が pending であることを確認する。
  3. 端末で `Ctrl+C` を 1 回押す。押した瞬間の時刻を控える。
  4. Network タブを 2 分間観察する。
- **期待結果:**
  - Ctrl+C から**ほぼ即座に**（30 秒待たずに）元の `/sse` が完了扱いになり、クライアントの再接続が始まる。
  - 再接続の `/sse` は `ERR_CONNECTION_REFUSED` で失敗する（サーバーはリスナーを既に閉じている）。
  - 再接続の試行間隔が指数的に伸び、**最大 10 回で停止して無限には続かない**。
- **確認ポイント:**
  - **「再接続が発生しないこと」を期待しない。** 2 つのクライアント実装はいずれも `onerror` で自前リトライするため、再接続の試行は必ず発生する。見るのは「30 秒待たずに始まるか」と「10 回で止まるか」の 2 点。
  - 503 を目視できる可能性は極めて低い（`server.close()` がシャットダウン冒頭で走るため、以後の試行は TCP レベルで拒否される）。503 が見えなくても異常ではない。

### 5. シグナル受信ログとタイムアウト警告の記録

- **対応する受け入れ基準:** AC-3 / AC-10
- **目的:** ADR-001 が「真因切り分けの唯一の手掛かり」と位置づけた 2 つの観測（どのシグナルでハンドラが起動したか / タイムアウトに救われているか）が、実運用の出力に実際に現れるかを確認して記録する。自動テストは「警告経路が存在すること」と「正常系で偽陽性が出ないこと」までしか担保しない。
- **手順:**
  1. 項目 1〜3 のすべての試行について、端末出力の全文を残す（`> log 2>&1` でも `script` コマンドでも可）。
  2. 各試行について次の 3 点を記録する。
     - `[peek] Received SIGINT, shutting down...` が表示されたか
     - `Shutting down...` の枠が表示されたか
     - タイムアウト警告（`[peek]` プレフィックス付き、「期限内に close しなかった」旨）が表示されたか
- **期待結果:**
  - 毎回 `Received SIGINT, shutting down...` が出る（= SIGINT ハンドラが確かに起動している。調査結果の可能性 (ii)「そもそもハンドラが起動していなかった」の否定）。
  - **正常系ではタイムアウト警告が出ない**（既定 2000ms のマージンに対して実測は数〜数十 ms なので、出たら偽陽性ではなく本物の異常を示す）。
- **確認ポイント:** 警告が 1 回でも出た場合は、その試行の条件（タブ数・放置時間・モード）を必ず記録する。**「10 回とも警告なし」も等しく重要な観測結果**なので、出なかった事実も PR に明記する。

### 6. Node 24 系（報告者環境）での確認

- **対応する受け入れ基準:** AC-1 / AC-10
- **目的:** 報告者は Node v24.15.0、これまでの検証は v22.22.1 で、**真因の残る有力な変数が Node のバージョン差**である。CI matrix（`ubuntu-latest` × Node 22 / 24）が `pnpm test` を回すためプロセスレベルの終了性テスト（AC-1）は Node 24 でも自動実行される。手動でしか埋まらないのは **macOS × 実ブラウザ × 実 Ctrl+C** の 3 条件のみなので、そこに絞る。
- **手順:**
  1. Node 24 を用意する。本リポジトリの `flake.nix` は devShell に `nodejs_22` を固定しており Node 24 の提供口が無いため、nix 経由で一時的に取得する（実行確認済み: `nix shell nixpkgs#nodejs_24 -c node --version` → `v24.18.0`）。
     ```bash
     nix shell nixpkgs#nodejs_24 -c node dist/index.mjs . --host 0.0.0.0 --port 3009
     ```
     実行確認済み（起動 → `GET /` 200 → SIGINT → `Server stopped. Bye!` → 正常終了）。
  2. ブラウザで `http://localhost:3009` を開き `/sse` が pending であることを確認する。
  3. 数分放置してから `Ctrl+C` を 1 回押す。
  4. 手順 1〜3 を **3 回**繰り返す。
- **期待結果:** Node 22 と同様に 5 秒以内・exit code 0 で終了する。
- **確認ポイント:** 報告者環境は v24.15.0、ここで使うのは v24.18.0 とパッチバージョンが異なる。**この差で再現性が変わりうる**ため、実際に使った `node --version` の出力を記録に残す。

## エッジケース・異常系

### 1. Ctrl+C を 2 回連続で押す（force exit 経路）

- **目的:** 1 回目のシャットダウンが有界化されたことで、2 回目の force exit（`process.exit(1)`）が「押しても意味がない保険」として残っているだけで、押した場合に壊れないことを確認する。**確認したいのは「2 回押しても壊れない・ハングしない」ことであって、`Force exiting...` を出させることではない。**
- **手順:**
  1. SSE 接続を張った状態で `Ctrl+C` を素早く 2 回連続で押す。
  2. `echo $?` を実行する。
- **期待結果:**
  - **通常は `Force exiting...` は表示されず、exit code は 0 になる。** 有界化により 1 回目のシャットダウンが 10ms 前後で完了するため、人間が素早く 2 回押しても 2 回目は既に終了したプロセスに届く（レビュー時の実測: 押下間隔 0〜30ms の 20 試行すべてが exit 0・`Force exiting...` 未出力、TTY での 120ms 間隔の `^C` × 2 も exit 0）。**force exit に到達しないこと自体が、有界シャットダウンが効いている証拠**である。
  - 2 回目が 1 回目の処理中に届いた場合は `Force exiting...` が表示され exit code 1 で即座に終了する。これも正常。
  - **どちらの場合も数秒以内にプロンプトが戻りハングしないこと**が本項目の判定基準。exit code は 0 でも 1 でもよい。
- **確認ポイント:** exit code が 0 で `Force exiting...` が出なかったことを「force exit 経路が壊れた」と判定しない。この経路は `server.close()` が本当にハングする状況でのみ到達する保険であり、その状況を作れば分岐が動くことは自動テストとレビュー時の実測（`close()` を永久ハングさせた版で 2/2 とも exit 1・`Force exiting...` 出力）で確認済みである。逆に**この手順で毎回 `Force exiting...` が出る場合は、1 回目のシャットダウンが遅い＝真因が生きている疑い**があるので、その事実を記録する。

### 2. パイプ / リダイレクト下での警告欠落と exit code

- **目的:** ADR-007 が stdio drain を採用しないと決めた判断の妥当性確認。drain を入れると uncaught EPIPE で exit code が 0 → 1 に変わることが実測されており、その回避が効いていること、かつ短い出力なら欠落しないことを確認する。
- **手順:**
  1. `node dist/index.mjs . --host 0.0.0.0 --port 3009 --no-open 2>&1 | tee /tmp/peek-shutdown.log` を対話端末で起動する。
  2. ブラウザで `http://localhost:3009` を開き `/sse` を pending にする。
  3. `Ctrl+C` を 1 回押す（`tee` にも SIGINT が届き先に死ぬ）。
  4. `/tmp/peek-shutdown.log` の中身と、パイプライン全体の exit code を確認する。
- **期待結果:**
  - `Shutting down...` と `Server stopped. Bye!` がログに残っている（短い出力は `process.exit(0)` 直前でも欠落しない）。
  - peek 自体が uncaught EPIPE で落ちない。
- **確認ポイント:** パイプライン経由なので `$?` は `tee` の終了状態になる点に注意。peek 自身の exit code を厳密に見たいときは項目 1 のリダイレクトなしの手順を使う。

### 3. SIGTERM で終了する

- **目的:** Issue の観測「SIGTERM を送ったら即座に終了した」との対比。SIGINT / SIGTERM は同じハンドラで受けるため、シグナル受信ログでどちらか識別できることも確認する。
- **手順:**
  1. `node dist/index.mjs . --host 0.0.0.0 --port 3009 --no-open > /tmp/peek-term.log 2>&1 &` で起動し PID を控える。
  2. ブラウザで開いて `/sse` を pending にする。
  3. `kill -TERM <pid>` を送り、`wait` で exit code を取る。
- **期待結果:** 5 秒以内に終了し exit code 0。ログに `Received SIGTERM, shutting down...` が出る（`SIGINT` ではない）。

### 4. SSE 接続が 1 本も無い状態での Ctrl+C（ベースライン）

- **目的:** 非退行のベースライン。SSE 接続の有無で終了時間が変わらないことを確認し、項目 1 の測定値の基準にする。
- **手順:**
  1. `--no-open` を付けて起動し、ブラウザを一度も開かずに `Ctrl+C` を押す。
  2. ブラウザで開いてからタブを閉じ、`/sse` が切れた状態にしてから `Ctrl+C` を押す。
- **期待結果:** どちらも即座（1 秒未満）に `Server stopped. Bye!` が出て exit code 0。タイムアウト警告は出ない。

### 5. `--host 0.0.0.0` で LAN 上の別デバイスからも接続した状態での Ctrl+C

- **目的:** Issue の再現条件が `--host 0.0.0.0` である以上、ループバック以外の実ソケットが残っている状態でも `closeAllConnections()` が効いて有界時間で終了することを確認する。
- **手順:**
  1. `node dist/index.mjs . --host 0.0.0.0 --port 3009` を起動する。
  2. 同一 LAN の別デバイス（スマートフォン等）のブラウザから `http://<開発機の LAN IP>:3009` を開き、SSE 接続を張る。
  3. ローカルのタブと合わせて 2 クライアント接続した状態で `Ctrl+C` を押す。
- **期待結果:** 5 秒以内に exit code 0 で終了する。別デバイス側のページは接続が切れる（無限ローディングにならない）。
- **確認ポイント:** 別デバイスが用意できない場合は、同一機から別ブラウザ（Safari と Chrome など）で `http://<LAN IP>:3009` を開いても代替になる。LAN IP は `ipconfig getifaddr en0` で取得できる。

## 既存機能への影響確認

- **ライブリロード（SSE のブロードキャスト経路）:** ステップ 6 で `/sse` ハンドラに 503 の早期拒否と登録直後の再チェックが入り、keep-alive の待機実装も差し替わる。**シャットダウンしていない通常時に SSE が壊れていないこと**を確認する: 起動してブラウザで開いた状態のまま、対象ディレクトリ配下の Markdown を編集して保存し、ブラウザが自動更新されること。ファイルの追加・削除でファイルツリーが更新されること。HTML ファイルモードでも同様に確認する。
- **`--port` 衝突時の起動失敗（listen エラー時のクリーンアップ経路）:** ステップ 6 の `closeAll` → `shutdown` 改名は listen エラー時のクリーンアップ呼び出しにも波及する。同じポートで 2 つ目の peek を起動し、`Port 3009 is already in use` が表示されて exit code 1 で終了すること、そのプロセスがハングして残らないことを確認する。
- **連続起動でのポート再利用:** タイムアウトで打ち切った場合でもリスニングハンドルは手順 2 の時点で閉じている（＝ポートは解放済み）という設計上の主張の実機確認。Ctrl+C で終了した直後（1 秒以内）に同じ `--port 3009` で再起動でき、`EADDRINUSE` にならないこと。項目 1 の 10 回試行を連続で回す過程で自然に確認できる。
- **通常の閲覧機能（ディレクトリブラウズ / ファイルツリーの開閉 / テーマ切替 / シンタックスハイライト）:** 本 Issue はシャットダウン経路の変更だが、`sse.ts` と `server/index.ts` を触るため念のため一通り操作して回帰が無いことを確認する。
- **`pnpm test` / `pnpm typecheck` / `pnpm lint:fix` / `pnpm format`:** CLAUDE.md の Code Quality 手順として実施する（自動テスト側の回帰確認）。
