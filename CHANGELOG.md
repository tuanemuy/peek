## [1.9.1](https://github.com/tuanemuy/peek/compare/v1.9.0...v1.9.1) (2026-08-11)


### Bug Fixes

* Ctrl+C でのシャットダウンを有界化しSSEのレースを構造的に塞ぐ ([3693d5d](https://github.com/tuanemuy/peek/commit/3693d5d485831946da160ba191c7bbf2cf17ca0c)), closes [#102](https://github.com/tuanemuy/peek/issues/102)
* **deps:** update dependency gunshi to ^0.37.0 ([be6480e](https://github.com/tuanemuy/peek/commit/be6480e965b1298fff119aa7d2d270bb419de69c))
* step() の同期性を型で表明し、手順3の回帰ガードを追加 ([3aff692](https://github.com/tuanemuy/peek/commit/3aff6922fc08e6cc436e48e96d8b0c839ae010b2)), closes [#102](https://github.com/tuanemuy/peek/issues/102)
* シャットダウンのエラー分離を手順ごとに分け、SSE の登録窓を塞ぐ ([5a44ecd](https://github.com/tuanemuy/peek/commit/5a44ecd650ef77c3ba7c7586d345c272f13174a2)), closes [#102](https://github.com/tuanemuy/peek/issues/102)
* レビュー指摘を反映しシャットダウン手順とテストの判別性を強化 ([b8e5da3](https://github.com/tuanemuy/peek/commit/b8e5da32942f91031650fa0fa67aa5efbb0c6b5f)), closes [#102](https://github.com/tuanemuy/peek/issues/102)

# [1.9.0](https://github.com/tuanemuy/peek/compare/v1.8.0...v1.9.0) (2026-06-07)


### Bug Fixes

* dev:server の content.css?inline 読み込みと start パスを修正 ([e501370](https://github.com/tuanemuy/peek/commit/e501370e785c47a4a1e59322302e9f0395019e6a)), closes [#95](https://github.com/tuanemuy/peek/issues/95)
* レビュー指摘対応（aria-label / Escape クリア / flex レイアウト / テスト追加） ([a4ec557](https://github.com/tuanemuy/peek/commit/a4ec5573de463b7ac21a70ac32c8657def36d5ed)), closes [#88](https://github.com/tuanemuy/peek/issues/88)


### Features

* ファイルツリーに検索（フィルタ）機能を追加 ([85a0b0f](https://github.com/tuanemuy/peek/commit/85a0b0f555054be700fbc3ef7a034ad4859bc602)), closes [#88](https://github.com/tuanemuy/peek/issues/88)

# [1.8.0](https://github.com/tuanemuy/peek/compare/v1.7.0...v1.8.0) (2026-06-07)


### Bug Fixes

* address review findings — pure toggle updater & defensive parseStore ([294ae66](https://github.com/tuanemuy/peek/commit/294ae661a8a85ff910601b22577864c999f4d15c)), closes [#001](https://github.com/tuanemuy/peek/issues/001) [#001](https://github.com/tuanemuy/peek/issues/001) [#001](https://github.com/tuanemuy/peek/issues/001) [#89](https://github.com/tuanemuy/peek/issues/89)


### Features

* persist file tree collapse state in localStorage ([197cb6e](https://github.com/tuanemuy/peek/commit/197cb6e50309d56bcffdcb11516e1bbbf911f8b4)), closes [#89](https://github.com/tuanemuy/peek/issues/89)

# [1.7.0](https://github.com/tuanemuy/peek/compare/v1.6.6...v1.7.0) (2026-03-24)


### Bug Fixes

* add error handling to shutdown() and lifecycle tests ([5955323](https://github.com/tuanemuy/peek/commit/5955323ca093f93526cb45df1b4d01b700ebe1e8)), closes [#63](https://github.com/tuanemuy/peek/issues/63)
* add idempotency guard to ServerInstance.shutdown() ([c55516d](https://github.com/tuanemuy/peek/commit/c55516d60724a1b97931763bde100b7ee931da05)), closes [#67](https://github.com/tuanemuy/peek/issues/67)
* add user feedback message before force exit ([8d723f3](https://github.com/tuanemuy/peek/commit/8d723f3c6fd60989da0a2af86d0c92f5c7b0dcc7)), closes [#68](https://github.com/tuanemuy/peek/issues/68)
* ensure Ctrl+C exits cleanly when SSE connections are active ([78182fa](https://github.com/tuanemuy/peek/commit/78182fac216dc0a0c5da746678f7b91d1d9d7efe)), closes [#61](https://github.com/tuanemuy/peek/issues/61)
* force exit on second SIGINT/SIGTERM ([3709538](https://github.com/tuanemuy/peek/commit/3709538e69a5846373de0ef32b4d2a5b3b0f4ddd)), closes [#68](https://github.com/tuanemuy/peek/issues/68)
* pass full error object to logger instead of error.message ([3749cae](https://github.com/tuanemuy/peek/commit/3749cae197aa6e94ec68d20e4becee08da7b17a2)), closes [#59](https://github.com/tuanemuy/peek/issues/59)
* use project logger instead of console.warn in watcher ([53f0b84](https://github.com/tuanemuy/peek/commit/53f0b84c9562da671d973c958260290d39b46dec)), closes [#59](https://github.com/tuanemuy/peek/issues/59)


### Features

* add console.warn logging on file watcher errors ([03db35c](https://github.com/tuanemuy/peek/commit/03db35c2d08c9777c42523a199183a4f93fbb81a)), closes [#59](https://github.com/tuanemuy/peek/issues/59)

## [1.6.6](https://github.com/tuanemuy/peek/compare/v1.6.5...v1.6.6) (2026-03-21)


### Bug Fixes

* remove explicit pnpm version to use packageManager field ([116a58c](https://github.com/tuanemuy/peek/commit/116a58ca36f9afcc5e1abce9143d2165ffb6f334))

## [1.6.5](https://github.com/tuanemuy/peek/compare/v1.6.4...v1.6.5) (2026-03-21)


### Bug Fixes

* handle EACCES error in directory watcher to prevent crash ([ee76761](https://github.com/tuanemuy/peek/commit/ee7676179f84ebfce7c10a720041c019c76c9483)), closes [#56](https://github.com/tuanemuy/peek/issues/56)
* improve error handling and tests for file watcher ([1c95f46](https://github.com/tuanemuy/peek/commit/1c95f462aa2a23352b7859d1e1d55f00c9d403b2)), closes [#56](https://github.com/tuanemuy/peek/issues/56)
* improve mock fidelity in watcher error handling tests ([5d0039a](https://github.com/tuanemuy/peek/commit/5d0039a0b5061627316f7c5df8ca725f971cd6d8)), closes [#56](https://github.com/tuanemuy/peek/issues/56)
* improve test reliability with proper mock behavior ([2b4fce1](https://github.com/tuanemuy/peek/commit/2b4fce15e31ebfd8be1bf5bc0457e0d504088e4f)), closes [#56](https://github.com/tuanemuy/peek/issues/56)
* simplify to minimal change - just add watchDirectory error handler ([45b8e42](https://github.com/tuanemuy/peek/commit/45b8e423adf151c575aaa71e0e2755dc1caf5da1)), closes [#56](https://github.com/tuanemuy/peek/issues/56)
* snapshot watchers array before iterating in close() ([b364df4](https://github.com/tuanemuy/peek/commit/b364df4deb5349da3f997b9fcecff7d2b163a05e)), closes [#56](https://github.com/tuanemuy/peek/issues/56)

## [1.6.4](https://github.com/tuanemuy/peek/compare/v1.6.3...v1.6.4) (2026-03-14)


### Bug Fixes

* update repository URL from peeks to peek ([7ae4f5f](https://github.com/tuanemuy/peek/commit/7ae4f5ff3663e541bac9208710ee93c556025d8d))

## [1.6.3](https://github.com/tuanemuy/markdown-peek/compare/v1.6.2...v1.6.3) (2026-03-14)


### Bug Fixes

* remove hardcoded dotfile exclusion and framework-specific ignore patterns ([596ee85](https://github.com/tuanemuy/markdown-peek/commit/596ee85f5e117c0b856dd3b20a3e4e967dc1f33d))

## [1.6.2](https://github.com/tuanemuy/markdown-peek/compare/v1.6.1...v1.6.2) (2026-03-14)


### Bug Fixes

* add explicit node types for tsgo compatibility ([495d57b](https://github.com/tuanemuy/markdown-peek/commit/495d57b8211a2a7b9d3ac355339de97ff7ed6190))
* migrate CSS imports to ?inline for tsdown v0.21.2 ([a071c2b](https://github.com/tuanemuy/markdown-peek/commit/a071c2bed7148e6a3d5d2ba25413feaff6720791))
* update tsdown to v0.21.2 and fix CSS text import ([2860a28](https://github.com/tuanemuy/markdown-peek/commit/2860a28e5f476927988095e3dc7fbaba7cbecd8a))

## [1.6.1](https://github.com/tuanemuy/markdown-peek/compare/v1.6.0...v1.6.1) (2026-03-14)


### Bug Fixes

* remove iframe sandbox attribute for local preview tool ([ab264fb](https://github.com/tuanemuy/markdown-peek/commit/ab264fb5433a77f6224e57d17db00f6852e9bb36)), closes [#38](https://github.com/tuanemuy/markdown-peek/issues/38)

# [1.6.0](https://github.com/tuanemuy/markdown-peek/compare/v1.5.1...v1.6.0) (2026-03-14)


### Bug Fixes

* address PR [#37](https://github.com/tuanemuy/markdown-peek/issues/37) review - security, type safety, and code quality ([9513cb0](https://github.com/tuanemuy/markdown-peek/commit/9513cb0b4b32ef5b758af19bb87d0bc5ac820371))
* address PR [#37](https://github.com/tuanemuy/markdown-peek/issues/37) review round 2 - security, quality, and test coverage ([100cdcb](https://github.com/tuanemuy/markdown-peek/commit/100cdcbe381927a20825002c617a5e7ef15fd52c))
* address PR [#37](https://github.com/tuanemuy/markdown-peek/issues/37) review round 3 - SSE bug, deduplication, and testing ([5db9d3b](https://github.com/tuanemuy/markdown-peek/commit/5db9d3bebf0c867cda90c5a61ebe67b8dcd64f8f))
* address PR [#37](https://github.com/tuanemuy/markdown-peek/issues/37) review round 4 - blocker fixes and improvements ([d0f263c](https://github.com/tuanemuy/markdown-peek/commit/d0f263cb0ca21bb60c3305282b9a50065365fc63))
* improve HTML preview iframe layout to fill available height ([baf07c4](https://github.com/tuanemuy/markdown-peek/commit/baf07c4091bce64a179eeaf3a1cf05896ed071ac)), closes [#app](https://github.com/tuanemuy/markdown-peek/issues/app)
* relax iframe sandbox and remove CSP for full HTML expressiveness ([f824d04](https://github.com/tuanemuy/markdown-peek/commit/f824d0495f90a6384cc3ea66ed1d13183a0ac74e))
* use standalone HTML document in catch-all route to prevent hydration mismatch ([bc16647](https://github.com/tuanemuy/markdown-peek/commit/bc16647514baa9a15707721b298fae05c9dc28da))


### Features

* add HTML file preview support ([b8a5ba8](https://github.com/tuanemuy/markdown-peek/commit/b8a5ba8d52f8814ad4a321c4e89643f18760b42f)), closes [#36](https://github.com/tuanemuy/markdown-peek/issues/36)

## [1.5.1](https://github.com/tuanemuy/markdown-peek/compare/v1.5.0...v1.5.1) (2026-03-03)


### Bug Fixes

* remove duplicate infrastructure/logger.ts and move logger to lib/ ([52501a1](https://github.com/tuanemuy/markdown-peek/commit/52501a1491a5315b17d44eeff5dabfe7d0acd9ab))

# [1.5.0](https://github.com/tuanemuy/markdown-peek/compare/v1.4.0...v1.5.0) (2026-03-03)


### Bug Fixes

* address review findings and extract navigation/SSE hooks ([dff0e77](https://github.com/tuanemuy/markdown-peek/commit/dff0e77069ca3d910df3b8145511f83deb1cddf6))


### Features

* add shared types and client utility modules ([f478526](https://github.com/tuanemuy/markdown-peek/commit/f4785261fe856a96140b43564959d86cd4c161c8))

# [1.4.0](https://github.com/tuanemuy/markdown-peek/compare/v1.3.1...v1.4.0) (2026-03-03)


### Bug Fixes

* use .js for generated favicon module to match client-bundle pattern ([303813f](https://github.com/tuanemuy/markdown-peek/commit/303813fe5551a9c51ab258fca38fe501b9ab649b))


### Features

* add favicon support ([fe2e0d5](https://github.com/tuanemuy/markdown-peek/commit/fe2e0d58640728b182fc50616cd3dd872f15d398))

## [1.3.1](https://github.com/tuanemuy/markdown-peek/compare/v1.3.0...v1.3.1) (2026-03-02)


### Bug Fixes

* make ExternalLink open standalone file view without sidebar layout ([d4a63df](https://github.com/tuanemuy/markdown-peek/commit/d4a63dfdf691f54697a18e9166e1d2c967054ff8))

# [1.3.0](https://github.com/tuanemuy/markdown-peek/compare/v1.2.1...v1.3.0) (2026-03-02)


### Features

* replace hardcoded colors with CSS variables ([1f39999](https://github.com/tuanemuy/markdown-peek/commit/1f3999930425501c9fb35c2a5e31c6a8c80b9680))

## [1.2.1](https://github.com/tuanemuy/markdown-peek/compare/v1.2.0...v1.2.1) (2026-03-02)


### Bug Fixes

* fix test and lint issues from dependency upgrades ([4f27439](https://github.com/tuanemuy/markdown-peek/commit/4f27439213f69c56526d99918040854c03c031ad))
* remove unintended content.css changes from PR ([cd87f9d](https://github.com/tuanemuy/markdown-peek/commit/cd87f9d6b750bd9a0a089e458dadf664723361c6))


### Reverts

* restore duplicate background-color in content.css ([94f416a](https://github.com/tuanemuy/markdown-peek/commit/94f416abc7ac51ebc665b130991d90ae3fdd2357))

# [1.2.0](https://github.com/tuanemuy/markdown-peek/compare/v1.1.2...v1.2.0) (2026-03-02)


### Features

* change code highlight theme from gruvbox to vitesse ([39942b1](https://github.com/tuanemuy/markdown-peek/commit/39942b1e9a11e29e753a4434f079e8f16a50e8a1))

## [1.1.2](https://github.com/tuanemuy/markdown-peek/compare/v1.1.1...v1.1.2) (2026-03-02)


### Bug Fixes

* move shebang banner to outputOptions for tsdown compatibility ([60650bf](https://github.com/tuanemuy/markdown-peek/commit/60650bfb0e4da009b530448ec87c1db49fbb11af))

# [1.1.0](https://github.com/tuanemuy/markdown-peek/compare/v1.0.4...v1.1.0) (2026-03-02)


### Bug Fixes

* prevent race condition and partial state in initMarkdown ([d9ca2f3](https://github.com/tuanemuy/markdown-peek/commit/d9ca2f356bcc09ab9492ac9d18aac2018a42e188))


### Features

* add syntax highlighting with Shiki via markdown-it ([95cd652](https://github.com/tuanemuy/markdown-peek/commit/95cd652ae553588aae32430230db45c2a908c824))
* expand supported languages to 50 with categorized list ([6f63d3c](https://github.com/tuanemuy/markdown-peek/commit/6f63d3cfc1e0df0f59a7a8a4b5847b3d8bd2aad5))
* load all bundled languages instead of a fixed subset ([1e880b2](https://github.com/tuanemuy/markdown-peek/commit/1e880b208a3d8e337d3d8b529a518b6e83c76247))

## [1.0.4](https://github.com/tuanemuy/markdown-peek/compare/v1.0.3...v1.0.4) (2026-03-02)


### Bug Fixes

* change CI trigger from push to pull_request on main ([a4cebe1](https://github.com/tuanemuy/markdown-peek/commit/a4cebe1b875f85c73694598e3b9fcebc6a310653))
* change release workflow trigger from workflow_run to push ([03333d6](https://github.com/tuanemuy/markdown-peek/commit/03333d66596b889d71a3d04f4878b862745b63ba))
* remove stale workflow_run condition from release workflow ([fd8baaf](https://github.com/tuanemuy/markdown-peek/commit/fd8baaf189ad28798a6e6182fdc7e9f520cddeb5))

## [1.0.3](https://github.com/tuanemuy/markdown-peek/compare/v1.0.2...v1.0.3) (2026-03-02)


### Bug Fixes

* remove leading ./ from bin path in package.json ([b951c93](https://github.com/tuanemuy/markdown-peek/commit/b951c93dadff39cc51408cc336532e111a264360))

## [1.0.2](https://github.com/tuanemuy/markdown-peek/compare/v1.0.1...v1.0.2) (2026-03-02)


### Bug Fixes

* add build step to release workflow before npm publish ([e4865b0](https://github.com/tuanemuy/markdown-peek/commit/e4865b0062b3abf0b10b0ab27c467ce531dd2a0d))

## [1.0.1](https://github.com/tuanemuy/markdown-peek/compare/v1.0.0...v1.0.1) (2026-03-02)


### Bug Fixes

* improve atomicity and type safety in DOM updater modules ([589c28e](https://github.com/tuanemuy/markdown-peek/commit/589c28e307f9eac2c008c8d5738684e31cfa536c))

# 1.0.0 (2026-03-02)


### Bug Fixes

* Add aria-hidden to decorative SVG icons in theme toggle example ([0f9eb5c](https://github.com/tuanemuy/markdown-peek/commit/0f9eb5c2c4c36510a298da76cb17e64cbe57ce46))
* Improve error handling in directory routes and style loading ([c52e01e](https://github.com/tuanemuy/markdown-peek/commit/c52e01e6453dd85360e4db30b94fbe765dd0ff41))
* Improve file watcher reliability ([a045ed5](https://github.com/tuanemuy/markdown-peek/commit/a045ed503ff936d3f9a149a7d7fc79dc9326a514))
* improve path validation and error type guard ([a549772](https://github.com/tuanemuy/markdown-peek/commit/a549772d7e13e6d4d9d73b67b0b91f1925b34fcd))


### Features

* add centralized logger utility ([171b974](https://github.com/tuanemuy/markdown-peek/commit/171b974dbd00c4ffee954ea46526f2f714c1737c))
* add CSP nonce support and improve server security ([e7632a4](https://github.com/tuanemuy/markdown-peek/commit/e7632a4db2ba2ec7b9af7bd56d4478bfed25939f))
* add utility functions to Result type ([e8bcbb0](https://github.com/tuanemuy/markdown-peek/commit/e8bcbb0a5bcb0a82021ab7a340cdc9c869f39db8))
* Implement markdown preview CLI with live reload ([d2947ae](https://github.com/tuanemuy/markdown-peek/commit/d2947aeeea40bef3cefc1f01890c015cfc1890de))
* Support .gitignore patterns in file tree scanning ([0a5bfd3](https://github.com/tuanemuy/markdown-peek/commit/0a5bfd3b735d0ff69d4481e2d25c3bcacade178a))
