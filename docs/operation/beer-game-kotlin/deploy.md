---
type: Playbook
title: "デプロイ手順書 - beer-game-kotlin"
description: "ステージング・本番へのデプロイの手順、スモークテスト、失敗時の対応。ワークフローは定義のみで、AWS では未実行・未検証。"
tags: [operation, deploy]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-15T00:00:00Z }
---

# デプロイ手順書

> **状態: 定義のみ。AWS では何も作っていない・実行していない。** ワークフローは YAML の構文検証だけを行い、一度も起動していない。Terraform も AWS へ適用していない。以下の手順は、**AWS の準備が済んだ後**に人が行うものである。
>
> 計画: [Bolt 3 計画](../../development/beer-game-kotlin/bolt_3_plan.md)（Step 3）。設計: [インフラストラクチャ](../../design/beer-game-kotlin/architecture-infrastructure.md)、[運用要件](../../design/beer-game-kotlin/operation.md)。

## 前提（AWS 未適用）

次が済んでいない間は、ワークフローを起動しない。起動しても失敗する。

- Terraform の適用（`apps/beer-game-kotlin/infra/`）。適用前に人が確認する項目と適用の順序は、[Bolt 3 計画](../../development/beer-game-kotlin/bolt_3_plan.md) の「Step 2 の結果」にある「AWS への適用の前に、人が確認すべき項目」と「設計書との食い違い・未決・未確認」（特に、初回のイメージの扱い）を参照する。**本書では創作しない。**
- アカウント、OIDC プロバイダー、状態用の S3、ドメインの準備。同じく上記と、[インフラストラクチャ](../../design/beer-game-kotlin/architecture-infrastructure.md) を参照する。
- GitHub の Environment（`staging`、`production`）の作成と、変数の設定（次節）。**`production` には、必須のレビュアー（保護ルール）を設定する。**
- beer-game2 の同種の手順書は書式の参考: [AWS ステージング環境セットアップ手順書](../beer-game-ts/aws_staging_setup.md)、[AWS プロダクション環境セットアップ・運用](../beer-game-ts/aws_production_setup.md)。Kotlin 版で変わる点は、JVM のコンテナ（ポート 8080、`/api/v1/ready`）、migrate モード、必要な秘密が 5 つ（DB の資格、`CREDENTIAL_KEY`・`IDEMPOTENCY_KEY`・`RESPONSE_KEY`）であること。

## ワークフロー

| ワークフロー | 起動 | 内容 |
| :--- | :--- | :--- |
| `beer-game-kotlin-deploy-staging` | 手動（`workflow_dispatch` のみ） | ビルド → ECR → migrate → api の更新 → 静的ファイル → スモークテスト。失敗時は自動で直前の版へ |
| `beer-game-kotlin-deploy-production` | 手動のみ。**承認（保護ルール）が前提** | ステージングで検証したダイジェストを昇格して、同じ手順で展開 |
| `beer-game-kotlin-rollback-staging` / `-production` | 手動のみ | 直前（または指定）の版へ戻す。[ロールバック手順書](./rollback.md) |

どれも `push`・`schedule` で自動起動しない。`push` はコメントアウトしてあり、有効にするかは、ステージングで動作を確認したうえで人が判断する。AWS の認証は OIDC（長期のアクセスキーを使わない）。

## 人が設定するもの（AWS 適用時）

値はワークフローに書かない。Terraform の出力（`terraform output`）から、GitHub の Environment の Variables に設定する。秘密（Secrets）は使わない。

| 変数 | 出力名・内容 | staging | production |
| :--- | :--- | :---: | :---: |
| `AWS_ROLE_ARN` | `deploy_role_arn` | 要 | 要 |
| `AWS_REGION` | リージョン | 要 | 要 |
| `ECR_REPOSITORY` | ECR のリポジトリ名（`ecr_repository_url` の最後の部分） | 要 | 要 |
| `STAGING_ECR_REPOSITORY` | 昇格元（ステージング）のリポジトリ名 | — | 要 |
| `ECS_CLUSTER` / `ECS_SERVICE` | `ecs_cluster` / `ecs_service` | 要 | 要 |
| `API_TASK_FAMILY` / `MIGRATE_TASK_FAMILY` | `api_task_family` / `migrate_task_family` | 要 | 要 |
| `WEB_BUCKET` / `DISTRIBUTION_ID` | `web_bucket` / `distribution_id` | 要 | 要 |
| `TASK_SG` | `task_security_group_id` | 要 | 要 |
| `TASK_SUBNETS` | `task_subnet_ids`（カンマ区切り） | 要 | 要 |
| `STAGING_URL` / `PRODUCTION_URL` | `url`（スモークテストの宛先） | 要 | 要 |

OIDC の信頼の条件は「このリポジトリの、この GitHub Environment」だけである（Terraform の `github_oidc`）。ワークフローの `environment:` の名前（`staging`、`production`）を変えない。

## 手順

### ステージング

1. 変更が `main`（またはデプロイしたいコミット）にあることを確認する。CI（`beer-game-kotlin`）が緑であること。
2. GitHub の Actions で `beer-game-kotlin-deploy-staging` を手動で起動する（ブランチは、デプロイしたいコミットのもの）。
3. 結果を確認する。成功すると、ログに**イメージのダイジェスト**（`sha256:...`）とコミット SHA が出る。本番へ昇格するときの入力になるので控える。

ワークフローの内部の順序:

1. 直前の版（api のタスク定義、静的ファイルの版）を記録する（自動ロールバックの戻り先）。
2. イメージをビルドして ECR へ push する（タグはコミット SHA、不変。同じコミットのイメージがあれば再利用）。以降は**ダイジェストで固定**する。
3. 現在のタスク定義を元に、イメージだけを差し替えた新しい版を、api と migrate の両方で登録する。
4. **migrate を、1 回限りの ECS タスクで実行**する。完了を待ち、終了コードが 0 でなければ**中止**する（api は更新しない）。
5. api サービスを更新する（ローリング。サーキットブレーカーが、健全にならない版を自動で戻す）。
6. 静的ファイル（`web/dist`）を `releases/<SHA>/` に置いて `current/` へ反映し、CloudFront を無効化する。
7. スモークテスト（次節）。
8. 成功したら、デプロイの履歴を S3 の `deployments/` に記録する（ロールバックの候補）。

### 本番

**確認必須。** ステージングで動作を確認した版だけを昇格する。

1. ステージングのデプロイの結果から、ダイジェストとコミット SHA を取る。
2. `beer-game-kotlin-deploy-production` を、入力 `digest` と `release` を指定して起動する。
3. `production` 環境の保護ルールで、レビュアーが承認すると実行される。承認の前に、ステージングでのスモークテストの結果、イベントの形を変える変更を含むか（含む場合は [ロールバック手順書](./rollback.md) の 2 段階リリース）を確認する。
4. 本番はビルドしない。ステージングの ECR から、同じダイジェストで本番の ECR へ昇格し、同じ手順（migrate → api → 静的ファイル → スモークテスト）で展開する。

## スモークテスト

| 検査 | 内容 | 場所 |
| :--- | :--- | :--- |
| コンテナのスモークテスト（CI・ローカル） | `docker build` と `scripts/container-smoke.sh`: api の `/api/v1/ready` が 200、migrate が終了コード 0、秘密が無ければ終了コード 78、H2 の拒否、非 root、起動時間 | CI の `container` ジョブ、[ローカルの実行](./container_local.md) |
| デプロイ後のスモークテスト | 公開 URL 経由で `/api/v1/ready`（準備。DB と通知の受信）と `/api/v1/health`（生存）が 200 になる。最大 30 回、5 秒間隔で待つ | デプロイ・ロールバックのワークフロー |

**未実装（未確認）**: 設計が定める業務のスモーク（作成・参加・SSE・ポーリング・自動確定）は、本 Bolt では作っていない。デプロイ後のスモークテストは、準備と生存の確認だけである。

## 失敗時の対応

| 失敗した工程 | 状態 | 対応 |
| :--- | :--- | :--- |
| ビルド・ECR への push | 何も変わっていない | ログを見て修正し、再度起動する |
| migrate が非 0 で終了 | **api は更新されない**。スキーマが途中まで変わっている可能性がある（Flyway の履歴で確認） | CloudWatch Logs の `/ecs/<名前>/migrate` を確認する。直して再度起動する。**マイグレーションは自動では戻さない** |
| api の更新が完了しない | サーキットブレーカーが、直前のタスク定義へ戻す。ワークフローは失敗 | ログと api のログ（`/ecs/<名前>/api`）を確認する。猶予期間（起動時間の実測前の初期案）の不足も疑う |
| スモークテストの失敗 | ワークフローが、直前のタスク定義と静的ファイルの版へ**自動で戻す**（マイグレーションは戻さない）。実行は失敗のまま | 原因を調べて直し、再度デプロイする。旧版へ戻せない場合は [ロールバック手順書](./rollback.md) の「戻せないケース」 |

自動ロールバックそのものが失敗した場合は、手動のロールバック（[ロールバック手順書](./rollback.md)）を使う。

## Bolt 14 での変更（本番の定義）

- **ステージングの自動デプロイ**（AC6.2.1）: main の CI（`beer-game-kotlin`）が成功すると、`workflow_run` でステージングのデプロイが起動する。**リポジトリの変数 `BEER_GAME_KOTLIN_AUTO_DEPLOY` が `'true'` のときだけ**（未設定の間はジョブを飛ばす）。手動で 1 回成功させてから設定する。
- **本番はブルー/グリーン**（ECS の組み込み）。ステージングはローリング。詳細は [本番の運用手順書](./production.md)。
- 追加の変数: `RETENTION_TASK_FAMILY`・`VERIFY_TASK_FAMILY`（両環境）、`RDS_INSTANCE`（本番。デプロイ前のスナップショット用）。いずれも `terraform output`。**未設定**（人が行う）。
- 定期のタスク（`retention`・`verify-projections`）のタスク定義も、同じダイジェストの新しい版を登録する。

## 未確認

- ワークフロー全体（AWS 上での動作）。`actionlint` と `shellcheck` は、ローカルに無く未実行。
- ブルー/グリーン。設計書の CodeDeploy ではなく、ECS の組み込み方式で定義した（AI の提案。未承認）。AWS 上の切り替え・待ち時間・自動の戻しは未確認。ステージングはローリングのため、本番で初めて動く。
- ステージングと本番の ECR が別アカウントの場合の昇格（現状は同一アカウントを前提）。
- `aws-actions/*`、`setup-java`、`gradle/actions` は、固定する SHA を確認できていないため、版のタグのまま。
- 新しい書く版（`schema_version`）を設定で切り替える仕組み（設計の未決。どこで持つか）。
