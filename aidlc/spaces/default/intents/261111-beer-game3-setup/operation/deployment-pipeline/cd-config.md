# CD の構成（設計） - beer-game3

これは設計だけで、AWS の資源の作成、ワークフローの作成、リポジトリの設定の変更は行っていません。実際の作成は、次の Environment Provisioning と Deployment Execution で、あなたの承認を得て行います。

出典: `construction/ci-pipeline/ci-config.md`、`quality-gates.md`、`construction/u6-nfr-verification/infrastructure-design/infrastructure-specification.md`、`cicd-pipeline.md`、`team.md`（Deployment）、`deployment-pipeline-questions.md`（Q1〜Q4）。

## 構成の要点

| 項目 | 内容 |
| :--- | :--- |
| 配備先 | AWS。ECS（Fargate）+ ロードバランサー（ALB）+ RDS for PostgreSQL 18（Q1 の A）。beer-game3 専用のアカウントまたは専用の資源 |
| イメージ | アプリケーションのコンテナのイメージを、AWS のレジストリ（ECR）に置く。Dockerfile は未作成（Deployment Execution の前に、承認を得て作る）。タグはコミットの識別子 |
| ワークフロー | beer-game3 用に別に新しく作る（`.github/workflows/beer-game3-deploy.yml`。CI の `beer-game3.yml` とは別）。既存の `beer-game2-deploy-*.yml` は再利用しない |
| 認証 | GitHub から AWS へは OIDC（長期のキーを保存しない）。ロールは環境ごとに分け、最小の権限にする |
| 環境 | `staging`、`production`。構成は規模だけが違う（同じ版の PostgreSQL 18、同じ IaC のテンプレート） |
| 移行 | `RUN_MIGRATIONS=true` のアプリケーションの起動時ではなく、配備の手順の中の専用のタスクで適用する（前方にだけ進める。拡張して縮小する方針） |
| 必須の設定 | `TRUSTED_PROXY_HOPS`（ALB の段数。staging と production で必須）、`APP_ENV`、鍵（`CODE_ENC_KEY`、`CODE_HMAC_KEY`）は AWS のシークレット管理に置く |

## 環境の昇格

| 段階 | 起動 | 条件 | 動作 |
| :--- | :--- | :--- | :--- |
| 1. CI | `develop` と `main` への PR | `gate` が成功 | 検証のみ |
| 2. staging | `main` への merge（自動） | `main` の CI（`gate`）が成功。イメージを作って ECR へ | ECS のサービスをローリングで更新、移行、スモーク試験（`/health`、作成から 1 週の確定までの短い通し） |
| 3. production | staging の成功のあと、手動承認 | GitHub の `production` 環境の保護（必須のレビュアー。Q3 の A）、staging と同じイメージの版 | ローリングで更新、移行、スモーク試験 |

リリース用 PR（`develop` から `main`）では、`load-main`（本試験）が成功していることが必須（CI の設計どおり）。

## 承認

production の手動承認は、GitHub の環境の保護で行う。必須のレビュアーと待ち時間の設定は、リポジトリの設定の変更のため、設定の前にあなたの承認を得る。

## 機能フラグ

使わない（Q4 の A）。機能の有効・無効の切り替えは、配備の版で行う。

## 未作成・未設定（準備だけ）

| 項目 | 状態 | 担当の工程 |
| :--- | :--- | :--- |
| AWS の資源（VPC、ECS、ALB、RDS、ECR、IAM のロール、シークレット） | 未作成 | Environment Provisioning（承認を得て） |
| Dockerfile、デプロイのワークフロー | 未作成 | Deployment Execution の前（承認を得て） |
| 必須のチェック（`gate`）と production の環境の保護の設定 | 未設定 | 承認を得て |
