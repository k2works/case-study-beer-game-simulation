# Code Structure

## ルート

| パス | 内容 |
| :--- | :--- |
| `apps/` | アプリ。`beer-game`（v1）と `beer-game2`（v2）。 |
| `docs/` | OKF（フロントマター）形式の文書。MkDocs で公開。 |
| `ops/` | `scripts/`（Gulp タスクの実体）、`docker/`（mkdoc、sonarqube-local）、`nix/`。 |
| `.github/workflows/` | CI/CD（8 本）。 |
| `gulpfile.js`、`mkdocs.yml`、`package.json`、`Dockerfile`、`docker-compose.yml`、`flake.nix`、`.devcontainer/` | 開発環境と文書運用。 |

## apps/beer-game2（`@beer-game2/app`）

```text
src/
  domain/        値、役割、条件、simulate-week、Game / Session 集約、観察、レビュー、出力、保持（12 ファイル）
  ports/         リポジトリ、UnitOfWork、Clock などの契約（index.ts）
  application/   ユースケース（index.ts 913 行）、errors
  adapters/
    http/        Fastify サーバー、資格
    persistence/ pg リポジトリ、通知、レート制限、出力・レビューの読み取り、unit of work
    observability/ EMF メトリクス
  config/        環境変数の読み込み
  compose.ts, main.ts, retention.ts   合成と起動
ui/              React: App、features（home/lobby/play/console/observe/review/role-panel）、api、components
migrations/      SQL 6 本（初期、確定方式、継続と資格、カスタム条件、観察者、保持）
infra/           Terraform: modules 9、envs 2（staging/production）
scripts/         acceptance-matrix、dev-bots、guided-tour、smoke、container-check、deploy/
tests/           unit 14、component 2、integration 9、e2e 4、support
```

分類: Model/Entity は `domain/`、Service/UseCase は `application/`、Repository は `adapters/persistence/`、Controller と Middleware は `adapters/http/`、Configuration は `config/` と `compose.ts`、Migration は `migrations/`、Test は `tests/`、Static は `ui/`。

## apps/beer-game（`@beer-game/app`、v1）

`src/{api,application,domain,infrastructure,learning,retention,security,ui}`、`migrations` 5 本、`tests/{u1..u5,e2e,manual}`、`performance/`、`infra/main.tf`。UI は `src/ui` 内（router なし。ADR-006）。

## コードのパターン

- 層の依存は lint で強制（domain は何にも依存しない）。
- JSDoc の `@landmark` と `@guidedTour` タグから、サイトシーイング・マップとガイドツアーを生成し、CI で一致を検査する。
- 値は金額を minor 単位の整数で保持。遅延は待ち行列の段の数で表す。
