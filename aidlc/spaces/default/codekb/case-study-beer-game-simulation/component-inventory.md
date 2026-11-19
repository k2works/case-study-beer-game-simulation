# Component Inventory

## beer-game2 domain
- 責任: 値、役割、条件（キット準拠とカスタム）、週次計算 `simulateWeek`、Game / Session 集約、観察、レビュー、出力、保持の規則。
- 場所: `apps/beer-game2/src/domain/`（12 ファイル）。
- 依存: なし（lint で他の層への依存を禁止）。

## beer-game2 ports
- 責任: リポジトリ、UnitOfWork、Clock などの契約。
- 場所: `apps/beer-game2/src/ports/index.ts`。
- 依存: domain。

## beer-game2 application
- 責任: ユースケース（読み込み → 集約の呼び出し → 保存）。規則は持たない。
- 場所: `apps/beer-game2/src/application/`。
- 依存: domain、ports。

## beer-game2 http adapter
- 責任: Fastify のルート、Problem JSON、資格（HMAC）、SSE。
- 場所: `apps/beer-game2/src/adapters/http/`。
- 依存: application、domain、ports、config。

## beer-game2 persistence adapter
- 責任: PostgreSQL への保存、unit of work、`LISTEN/NOTIFY`、レート制限、出力・レビューの読み取り。
- 場所: `apps/beer-game2/src/adapters/persistence/`、`migrations/`。
- 依存: ports、domain、`pg`。

## beer-game2 ui
- 責任: React の画面（ホーム、ロビー、プレイ、コンソール、観察、振り返り）、API クライアント、折れ線グラフ。
- 場所: `apps/beer-game2/ui/`。
- 依存: HTTP API、react-router。

## beer-game2 infra
- 責任: AWS の Terraform（alb、ecr、ecs、github_oidc、network、observability、rds、secrets、web）と staging / production の合成。
- 場所: `apps/beer-game2/infra/`。

## beer-game v1 app
- 責任: v1 の API・UI・保持ワーカー（SQS）・outbox・学習ビュー。参照用。
- 場所: `apps/beer-game/`。

## Documentation set
- 責任: 要件、設計、ADR、開発計画、運用手順、レビュー、ジャーナル、ガイド、テンプレート。
- 場所: `docs/`。MkDocs（`mkdocs.yml`）で公開。

## Ops tooling
- 責任: Gulp タスク（MkDocs、マニュアル、ジャーナル、vault、SSH、SonarQube、OKF）。
- 場所: `gulpfile.js`、`ops/scripts/`、`ops/docker/`、`ops/nix/`。

## CI workflows
- 責任: beer-game2 の CI と staging / production のデプロイ・ロールバック、v1 の CI、Docker 公開、MkDocs 公開。
- 場所: `.github/workflows/`（8 本）。
