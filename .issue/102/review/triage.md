# 指摘台帳 — Issue #102 / PR #116

照合キーは **Key（ファイル＋シンボル＋問題カテゴリ）** で正規化する。指摘 ID はラウンドごとに振り直されるため、既出判定はこの Key で行う。

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `src/server/shutdown-process.test.ts:AC-1テスト/判別性` | R1 | fix | ハング注入でも exit 0 で自然終了し PASS する。`Server stopped. Bye!` の出力を assert して塞ぐ | 0 |
| `src/server/index.ts:isHttpServer/型安全性` | R1 | fix | 手書き型述語はコンパイラ未検証のアサーション。検証済みの `in` ナローイングに戻す方が CLAUDE.md の原則に適う | 0 |
| `src/server/index.ts:shutdown/手順順序` | R1 | fix | 「再接続を誘発する前にリスナーを止める」という根拠に従うなら `close()` が手順 1。Issue 修正案 1 とも一致 | 0 |
| `src/server/index.ts:shutdown/エラー分離` | R1 | fix | 手順 1〜4 のいずれかが throw すると `close()` に到達せずハングしうる | 0 |
| `src/server/index.ts:shutdownPromise/再入ガード` | R1 | fix | memo 代入が手順 1〜4 の後に完了するため、その間は再入ガードが無効。同期実行への依存は本 PR が消そうとしているもの | 0 |
| `src/server/routes/sse.ts:onAbort登録順序` | R1 | fix | `stream.onAbort()` を `clients.add()` より前に置く方が厳密に安全。コストゼロ | 0 |
| `src/server/routes/sse.ts:②再チェック/コメント誤り` | R1 | fix | 「the response was already handed back」は事実誤り。現行 Hono では到達不能な旨も未記載 | 0 |
| `src/server/index.ts:手順4コメント/Node19+の事実` | R1 | fix | `http.Server.close()` は内部で `closeIdleConnections()` を呼ぶため、コメントの根拠が不正確 | 0 |
| `src/lib/with-timeout.ts:clearTimeout/回帰ガード` | R1 | fix | `clearTimeout` を両方削除しても 7 ケース全 PASS。計画が「唯一の自動検証」とした箇所が空振り | 0 |
| `src/server/index.test.ts:ADR-002順序/回帰ガード` | R1 | fix | `close()` を `closeAllConnections()` より先に呼ぶ契約に回帰ガードが無い（best effort、不可能なら wont-fix に降格） | 0 |
| `src/server/routes/sse.test.ts:AC-8/reader null 退化` | R1 | fix | `if (reader)` 内なので `res.body` が null だと無言で弱いテストに退化する | 0 |
| `src/server/shutdown-process.test.ts:getFreePort/失敗診断` | R1 | fix | ポート衝突が「20 秒後に起動しなかった」に化けて原因が読めない。子プロセスの stderr を失敗メッセージに含める | 0 |
| `src/server/index.test.ts:shutting/フローティングPromise` | R1 | fix | await を跨いでフローティングにしている | 0 |
| `src/lib/with-timeout.ts:doc/reject透過の記述` | R1 | fix | タイムアウト後・予算ゼロでは reject が無言で消えるのに、doc は無条件に透過と書いている | 0 |
| `src/lib/with-timeout.ts:配置根拠の不整合` | R1 | fix | 根拠の記述のみ修正（配置は `src/lib/` のまま）。`src/core/` はクライアントバンドル対象で、サーバー専用モジュールを置くと不要にバンドルが太る | 0 |
| `src/server/index.ts:shutdown/timeoutMs注入API` | R1 | fix | memo 化により 2 回目以降無視される契約が型と矛盾。`startServer()` のオプションに移して型で矛盾を消す | 0 |
| `src/server/index.ts:ServerInstance.watcher/削除基準の一貫性` | R1 | fix | ADR-005 の基準を `watcher` にも一貫適用する（未使用なら削除、残すなら理由を明記） | 0 |
| `src/server/routes/sse.ts:SseManager.shutdown/doc参照先` | R1 | fix | doc が `see createSseManager()` を指すが同関数に doc が無い | 0 |
| `src/lib/with-timeout.ts:docコメント過剰` | R1 | fix | doc 32 行 > 実装 26 行。ADR の議論をコードに持ち込んでいる | 0 |
| `src/server/shutdown-process.test.ts:配置` | R1 | fix | CLI を spawn するテストがサーバー層ディレクトリにある | 0 |
| `.issue/102/testing.md:警告と枠描画の期待` | R1 | fix | タイムアウト警告は clack の枠内に割り込む。testing.md の「枠が崩れていないこと」と衝突するので期待を現実に合わせる | 0 |
| `.issue/102/testing.md:force exit の期待` | R1 | fix | 修正後は正常系のシャットダウンが 10ms で完了するため、Ctrl+C 2 回でも force exit に到達しない。期待結果を現実に合わせる | 0 |
| `src/index.ts:logger.info/正常系出力への混入` | R1 | wont-fix | 意図的な診断ログ（ADR、計画 1 周目 S-009）。真因未特定の本 Issue では「ハンドラが起動したか」を事後に判別できることが警告と並ぶ唯一の手掛かり。実 TTY で clack の枠描画と `^C` エコーの分離を検証済み | 0 |
| `src/server/shutdown-process.test.ts:dist/index.mjs未起動` | R1 | wont-fix | `pretest` は tsdown を実行しないため `dist/` の存在が保証されず、テストがビルド順序に依存する。`dist/index.mjs` の起動は Phase 4 の手動確認（testing.md が既に採用）で埋める | 0 |
| `plan.md:AC-10/手動確認未実施` | R1 | wont-fix | Phase 4 のブラウザ検証で実施する作業項目であり、実装起因の欠陥ではない | 0 |
