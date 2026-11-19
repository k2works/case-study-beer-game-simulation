## Developer Code Scan Results

スキャン日: 2026-11-11 / head_commit: a5077d43ea409254a4d9656a2b4d1bd5638ae4b2 / 幅: Full rescan（snapshot paths: `./`）/ Depth: Standard。読むだけで、テスト・ビルド・プログラムは実行していない。

### Scan Coverage
- **Analyzed deeply**:
  - `docs/requirements/beer-game/`（`requirements_definition.md` を全文読了。他 4 文書は行数と一覧のみ確認）
  - `docs/requirements/beer-game2/index.md`、`docs/requirements/beer-game2/requirements_definition.md`（FR/NFR/BR 表）
  - `apps/beer-game2/`（`package.json`、`vitest.config.ts`、`eslint.config.js`、`tsconfig.json`、`Dockerfile`、`compose.yaml`、`README.md`、`.nvmrc`、`src/domain/simulate-week.ts`、`src/adapters/http/server.ts` のルート定義、`infra/` と `migrations/` と `scripts/` と `tests/` と `ui/` の構成と行数）
  - `apps/beer-game/`（`package.json`、`README.md`、`.gitignore`、`src/domain/simulation-engine.ts`、`src/`・`tests/`・`migrations/` の構成と行数）
  - `.github/workflows/`（`beer-game2.yml` の主要ジョブ、`beer-game2-deploy-*.yml`・`rollback-*.yml` の冒頭、`beer-game-u1.yml`、`docker-publish.yml`、`mkdocs.yml` の冒頭）
  - ルート設定（`package.json`、`gulpfile.js`、`mkdocs.yml`、`.env.example`、`.gitignore`、`Dockerfile`、`README.md`）
- **Skimmed only**:
  - `docs/design/`・`docs/adr/`・`docs/development/`・`docs/operation/`・`docs/review/`・`docs/journal/`（`beer-game` / `beer-game2` のファイル一覧と、`beer-game2/tech-stack.md` の冒頭のみ）
  - `docs/reference/`・`docs/template/`・`docs/article/`・`docs/strategy/`・`docs/index.md`（一覧と冒頭のみ）
  - `docs/requirements/beer-game/` の `business_usecase.md`、`system_usecase.md`、`user_story.md`（行数のみ）
  - `ops/scripts/*.js`、`ops/docker/`、`ops/nix/`、`.devcontainer/`（ファイル名と Gulp への登録のみ）
  - `apps/beer-game/` と `apps/beer-game2/` の個別ソース（`src/application/`、`src/adapters/persistence/`、`ui/src/`、`tests/` の中身は読まず、ファイル名と行数で把握）
  - `apps/beer-game2/infra/`（Terraform のモジュール名のみ）
- **Left out**（開かない）:
  - `.gitignore` が無視する出力・依存: `node_modules/`（ルート、`apps/beer-game/`、`apps/beer-game2/`）、`apps/*/coverage/`、`apps/*/dist/`、`apps/*/test-results/`、`apps/beer-game/.browser-binaries/`（Chrome for Testing）、`apps/beer-game/aidlc/`（`apps/beer-game/.gitignore` で除外される AI-DLC の作業物）、`.idea/`、`.env`、`.env.vault`
  - AI-DLC 自身の導入物: `.claude/`、`.codex/`、`.agents/`、`aidlc/` ワークスペース、`AGENTS.md` と `CLAUDE.md` の AI-DLC 管理部分
  - 参考として、`.claude/`・`.agents/` 配下は読んでいない。`.github/` 配下に aidlc 名のものは見当たらなかった。

### Packages Found
- `@beer-game2/app`（`apps/beer-game2/`）— アプリケーション（フルスタック）— TypeScript（Node 26 / ESM）— ビールゲーム v2 の実装。`src/`（domain / ports / application / adapters{http, persistence, observability} / config）と `ui/`（Vite + React）と `migrations/`（6 本）と `infra/`（Terraform）を持つ。tracked 156 ファイル、`src`・`ui`・`tests`・`scripts` で約 18,000 行。
- `@beer-game/app`（`apps/beer-game/`）— アプリケーション（フルスタック）— TypeScript（Node 22）— ビールゲーム v1 の実装。`beer-game2/README.md` が「参照用に残している」と明記。`src/`（api / application / domain / infrastructure / learning / retention / security / ui）と `migrations/`（5 本）と `performance/`（負荷試験）。約 9,800 行。
- ルートの `package.json`（`name` が空）— ドキュメント運用用ツール群 — JavaScript（ESM）— Gulp タスク（`ops/scripts/*.js`）で MkDocs、マニュアル生成、ジャーナル、vault、SSH、SonarQube、OKF を駆動する。
- `apps/beer-game3/` — **存在しない**。リポジトリ全体に `beer-game3` を含む AI-DLC 外のファイルは無い（`grep` で 0 件）。`docs/requirements/` にも `beer-game3` は未登録。

### Build System
- **Type**: アプリごとに npm（`package-lock.json`）。アプリ内で Vite（UI）、`tsc`（beer-game2 は `tsconfig.build.json` で本番ビルド）、`tsx`（実行）、`node-pg-migrate`（beer-game2 のマイグレーション）。ルートは npm + Gulp 5。
- **Config Files**: `apps/beer-game2/{package.json,tsconfig.json,tsconfig.build.json,vite.config.ts,vitest.config.ts,eslint.config.js,.prettierrc.json,.nvmrc,Dockerfile,compose.yaml,playwright.config.ts}`、`apps/beer-game/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,eslint.config.js,Dockerfile,compose.yaml,playwright.config.ts}`、ルート `{package.json,gulpfile.js,mkdocs.yml,.env.example,Dockerfile,docker-compose.yml,flake.nix}`。
- **Build Dependencies**: beer-game2 は `src`（Node）と `ui`（Vite）が同一パッケージ内。`npm run build` が `tsc -p tsconfig.build.json`、`build:ui` が `vite build`。`npm run verify` は format:check → lint → typecheck → test:coverage → acceptance → docs:tour:check → e2e を直列に実行する。パッケージ間の依存はない（2 アプリは独立）。
- Node の版が不揃い: beer-game2 は `engines.node >=26`・`.nvmrc` 26、beer-game は CI の `node-version: 22`、ルート `README.md` と ルート `Dockerfile` は 22。

### APIs Discovered
- **REST（Fastify 5）**— `apps/beer-game2/src/adapters/http/server.ts`（615 行）— `grep` で確認した範囲で約 22 ルート: `GET /health`、`POST /api/games`、`POST /api/join`、`POST /api/recover`、`POST /api/observe`、`POST/DELETE /api/games/:id/observer-invitations`、`GET /api/games/:id/{observation,lobby,me,review,export,console,stream}`、`POST /api/games/:id/{credentials/reissue,assignments,start,commit}`、`DELETE …/assignments`、`PUT /api/games/:id/{decision,commit-mode,proxy-decision}`、および一時停止・再開・終了系（`/api/games/:id/${action}`）。エラー表現は Problem JSON。
- **SSE**— `GET /api/games/:id/stream`（バージョン通知のみ。ADR-006）、PostgreSQL の `LISTEN/NOTIFY`（`pg-notifier.ts`）で通知。
- **REST（v1）**— `apps/beer-game/src/api/app.ts`（562 行）。`Idempotency-Key`・`If-Match`・同一 Origin 検査、SQS による保持期間削除のワーカー（`src/retention/`）を持つ。v1 固有の設計。
- ルートの Gulp タスク: `mkdocs:*`、`manual:*`、`journal:generate`、`vault:*`、`ssh:*`、`sonar:*`、`okf:*`。

### Frameworks & Libraries
- **beer-game2**（`apps/beer-game2/package.json`）: Node 26、TypeScript 6.0.3、Fastify 5.12.8、`@fastify/cookie` 11.1.5、`pg` 8.23.1、`node-pg-migrate` 9.0.0、`zod` 4.6.7、React 19.3.1、`react-router` 8.5.1、Vite 8.3.6、Vitest 5.1.0、ESLint 10.14.0 + typescript-eslint 8.72.1、Prettier 3.9.10、Playwright 1.65.0、`@axe-core/playwright` 4.14.0、`fast-check` 4.10.2、Testing Library、PostgreSQL 18（compose）。版はすべて固定（`^` なし）。
- **beer-game（v1）**: TypeScript ^5.9.3、Fastify ^5.6.1、React ^19.2.0、Vitest ^4.0.6、ESLint ^9.39、`@aws-sdk/client-sqs`、`@fastify/cors`・`rate-limit`・`static`。版は `^` 範囲。
- **ルート**: Gulp ^5.0.0、dotenv ^17.2.3、marked ^18.0.9、plantuml-encoder ^1.4.0。MkDocs（Material、PlantUML、Mermaid 11、MathJax 3）。
- **インフラ**: Terraform（`~> 6.0` AWS プロバイダー）、モジュール: alb / ecr / ecs / github_oidc / network / observability（CloudWatch Synthetics canary を含む）/ rds / secrets / web（`apps/beer-game2/infra/modules/`）。`envs/staging`・`envs/production` で合成。

### Test Coverage
- **Test Directories**: `apps/beer-game2/tests/{unit,component,integration,e2e,support}`（unit 14 ファイル、component 2、integration 9、e2e 4。`use-cases.test.ts` 1,611 行、`app.test.tsx` 1,529 行、`http.test.ts` 1,062 行と大きい）。`apps/beer-game/tests/{u1..u5,e2e,manual}`（U 単位で整理）。
- **Test Frameworks**: Vitest（unit・component・integration）、Testing Library + jsdom（UI）、`fast-check`（プロパティテスト）、Playwright（E2E、専用ポートは人の開発サーバー 3000/5173 と分ける運用）、`@axe-core/playwright`（アクセシビリティ）。受入条件とテストの対応表は `npm run acceptance`（`scripts/acceptance-matrix.ts`）で未対応があれば失敗させる。
- **Coverage Config**: 存在（beer-game2 の `vitest.config.ts`）。provider v8、対象は `src/domain`・`src/application`・`src/adapters/http`・`src/adapters/persistence`、しきい値は lines/functions/statements 85、branches 75。チームの floor（80% line）を上回る。beer-game は `test:coverage` が `tests/u1..u5` に限定。
- 統合テストは同じテスト DB を共有するため `fileParallelism: false`（直列）。
- 実測のカバレッジ値は未確認（実行しないため）。`apps/*/coverage/` は無視対象で開いていない。

### Code Quality Indicators
- **Linting**: ESLint（beer-game2 は `eslint . --max-warnings=0`）。`eslint.config.js` で `no-restricted-imports` により層の依存を検査（domain → なし、ports → domain、application → domain/ports、adapters → 内側すべて。ADR-003）。Prettier（`format:check`）、`tsc --noEmit`（`strict` + `noUncheckedIndexedAccess`）。
- **CI/CD**: `.github/workflows/beer-game2.yml`（verify / e2e / container / infra / scripts の 5 ジョブ。`npm audit --omit=dev --audit-level=high`、`docs:tour:check`、Terraform `fmt`・`validate`、`shellcheck`）、`beer-game2-deploy-{staging,production}.yml`・`beer-game2-rollback-{staging,production}.yml`（OIDC、手動起動。staging は `push` トリガーがコメントアウトされ「まだ AWS で実行・検証していない」と明記）、`beer-game-u1.yml`（v1 の CI。Node 22、PostgreSQL 16）、`docker-publish.yml`（tag または手動）、`mkdocs.yml`（`main` push）。
- **Documentation**: ルート `README.md` は概要・目的が空欄のテンプレート（Quick Start と Claude 設定のみ）。`apps/beer-game2/README.md` は充実（構成、コマンド表、Living Documentation の案内）。`docs/` は OKF（フロントマター）+ MkDocs。プロジェクト別に `requirements/`・`design/`・`adr/`・`development/`・`operation/`・`review/`・`journal/` を持ち、beer-game2 は ADR 13 本、Bolt 1〜12 の計画と報告、リリース報告書 0.2.0、ガイドツアー（`@guidedTour`・`@landmark` タグから生成）を整備。beer-game（v1）側の `docs/development/` と `docs/operation/` と `docs/review/` は `index.md` のみ。

### Technical Debt Signals
- **`apps/beer-game3` が無い**: 本 Intent の対象は新規作成。`docs/requirements/beer-game3`・`docs/design/beer-game3` 等も無く、`docs/requirements/index.md` と `docs/index.md`、`mkdocs.yml` の nav にも未登録。作成は `apply-docs-structure`（add-project）の対象。
- **v1 要件と v2 要件の差**: 対象の要件（`docs/requirements/beer-game/requirements_definition.md`）は FR-01〜FR-15、NFR-01〜NFR-10、BR-01〜BR-14、UC-01〜UC-15、ASM-01〜ASM-05。beer-game2 の要件は FR-16（共同入力）、FR-17（観察者）、FR-18（自動確定）、NFR-11（観測性）、NFR-12（運用性）、BR-15〜BR-17 が加わり、FR-01 に「週数 1〜50」の記述がある。beer-game3 の範囲に v2 の追加分を含めるかは、要件側の判断として未確定。
- **ASM-01 が未確定**: 既定の顧客需要系列（JSD の既定値）が実装前に照合されていない。`project.md` の Correction「JSD preset 未確定時は custom series で技術検証を先行できるが、JSD 準拠の受入判定は保留する」と一致する論点。
- **ルートの未整備**: ルート `package.json` の `name` が空で、`repository.url`・`bugs`・`homepage` が `{project_name}` のまま。`mkdocs.yml` の `site_name: Site Name`、`repo_name: claude-code-booster`、リポジトリ名が booster 由来。ルート `README.md` の概要・目的が空欄。
- **Node 版の不一致**: 上記 Build System 参照。ルート `README.md` は 22.x、beer-game2 は 26、CI は beer-game が 22。beer-game3 の版は未決定。
- **2 つのアプリが並存**: `apps/beer-game`（v1、参照用）と `apps/beer-game2`。ワークフロー・Dockerfile・マイグレーションは重複している。3 つ目を足すと保守対象が増える。ワークフローはアプリ名で固定（`beer-game2*.yml`）で、`paths` もアプリ別。
- **ステージング未検証**: beer-game2 の staging / production デプロイは AWS 上で未実行（ワークフローのコメントと `docs/development/beer-game2/release_report-0_2_0.md` の題名「ステージングは未達」より）。チームの Deployment 規約（`main` merge で staging 自動反映）は beer-game2 でも未達。
- **巨大なテストファイル**: `use-cases.test.ts`（1,611 行）、`app.test.tsx`（1,529 行）、`http.test.ts`（1,062 行）。`application/index.ts` が 913 行、`pg-repositories.ts` が 684 行、`http/server.ts` が 615 行。500 行超のファイルが複数あり、分割の余地がある。
- TODO / FIXME / HACK / `eslint-disable` / `@ts-ignore` は `apps/beer-game2/src`・`ui`・`apps/beer-game/src` で 0 件（`grep`）。
- `.env.vault` と `.env.example` がある（秘密は暗号化管理。`.env` は無視）。資格情報の直書きは今回の範囲では見ていない。ただし `compose.yaml` と CI の `local-only` はローカル専用の値。
- `apps/beer-game/.browser-binaries/`（Chrome for Testing）がローカルに存在する。`.gitignore` で除外されており追跡されていない。

## Handoff Summary
- **Intent-relevant finding**: 実装の再利用元は `apps/beer-game2/`。`src/` が ports and adapters、`ui/` が Vite + React、`tests/` が unit / component / integration / e2e、`migrations/` が 6 本、`infra/` が Terraform（`apps/beer-game2/src/`、`apps/beer-game2/eslint.config.js` の層依存ルール、`apps/beer-game2/package.json` の `verify`）。週次計算は `apps/beer-game2/src/domain/simulate-week.ts` の純粋関数 1 つに閉じる。`apps/beer-game3/` は未存在のため、新規作成になる。要件の入力となる `docs/requirements/beer-game/requirements_definition.md` は v1 の範囲（FR 15 件）で、v2 で足された FR-16〜FR-18 と NFR-11〜NFR-12 を含まない（`docs/requirements/beer-game2/requirements_definition.md` と比較）。
- **Risks / follow-up**:
  - beer-game3 の範囲（v1 要件のみか、v2 の追加分を含めるか）と、v1 / v2 のコードのどちらを土台にするかは、スキャンでは決められない。要件定義と設計の段階で人が決める必要がある。
  - ドキュメントの追加先は `docs/<category>/beer-game3/` で、`docs/requirements/index.md`、`docs/index.md`、`mkdocs.yml` の nav を更新する必要がある（`apply-docs-structure` の add-project）。
  - CI は `beer-game2.yml` のようにアプリ名固定・`paths` 固定。beer-game3 用のワークフローは別途必要になる。
  - Node の版と Postgres の版（beer-game2 は 26 と 18、beer-game の CI は 22 と 16）を揃える決定が要る。チーム規約（`team.md`）は formatter・linter・type-check の CI 実行と、80% line coverage floor を要求する。beer-game2 は 85% で超えている。
  - ASM-01（既定需要系列）の未確定は受入判定に影響する。`project.md` の「JSD preset 未確定時は custom series で先行」の規約を引き継ぐこと。
  - beer-game2 のデプロイ経路は AWS 上で未検証。同じ構成を流用する場合、staging 自動反映の規約は未達のまま引き継ぐ。
