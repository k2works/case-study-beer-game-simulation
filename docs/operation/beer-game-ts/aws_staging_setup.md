---
type: Reference
title: "AWS ステージング環境セットアップ手順書 - beer-game2"
description: "ステージング環境の構成、費用の概算（未確認）、人が行う準備と手順、デプロイとロールバック。コードは用意したが、AWS では未実行・未検証。"
tags: [operation, setup]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-10T04:55:00Z }
---

# AWS ステージング環境セットアップ手順書

> **状態: 準備のみ。AWS では何も作っていない・実行していない。** Terraform、デプロイ・ロールバックのスクリプトとワークフローは用意し、ローカルと CI でできる検査（`fmt`、`validate`、`shellcheck`、`actionlint`、コンテナの検証）は通した。AWS 上での動作（`plan`/`apply`、デプロイ、SSE が CloudFront と ALB を通ること、ロールバック）は**未検証**で、下の手順で人が確認する。
>
> 計画: [Bolt 2](../../development/beer-game2/bolt_2_plan.md)

## 構成（ステージング）

[インフラ設計](../../design/beer-game2/architecture-infrastructure.md)から、費用を抑える次の差分を提案する。本番の構成は B12 で設計どおりにする。

| 要素                  | 設計（本番）                                           | ステージング（提案）                                                                  |
| :-------------------- | :----------------------------------------------------- | :------------------------------------------------------------------------------------ |
| RDS for PostgreSQL 18 | Multi-AZ、削除保護                                     | Single-AZ、PITR あり、削除保護なし                                                    |
| API（ECS Fargate）    | 常時 2 タスク、2〜4 に自動増減                         | 1 タスク、ローリング更新                                                              |
| ネットワーク          | プライベートサブネット + NAT または VPC エンドポイント | タスクは公開サブネット（セキュリティグループで ALB からのみ許可）、RDS はプライベート |
| 配信                  | CloudFront + 独自ドメイン（ACM）                       | CloudFront の既定のドメイン（独自ドメインは B12）                                     |

## 費用の概算（要確認）

**公式の料金表では確認していない概算**（東京リージョン、1 ドル = 為替未換算、月額、2026-11 時点の記憶に基づく）。実際の見積もりは、人が AWS Pricing Calculator で確認する。

| 項目                                                |   概算（月額） | 備考                                        |
| :-------------------------------------------------- | -------------: | :------------------------------------------ |
| RDS db.t4g.micro、Single-AZ、20 GB                  |         約 $20 | インスタンスの種類は負荷試験（B13）で見直す |
| ECS Fargate 0.25 vCPU / 0.5 GB × 1                  |         約 $10 | 常時起動                                    |
| ALB                                                 |     約 $20〜25 | 時間料金 + LCU                              |
| CloudFront / S3 / ECR / CloudWatch Logs             |          約 $5 | 少量の利用                                  |
| Secrets Manager（約 4 件）                          |          約 $2 | 1 件 $0.4                                   |
| **合計（ネットワーク費用なし）**                    | **約 $55〜65** |                                             |
| 参考: NAT ゲートウェイを追加                        |        +約 $45 | プライベートサブネットのタスク用            |
| 参考: VPC エンドポイント（ECR、Logs、Secrets など） |    +約 $40〜60 | NAT と同程度。「NAT なし」で安くならない    |

使わない時間にタスクと DB を停止すれば、さらに下げられる。

## 人が行う準備（AI は認証情報を扱わない）

- [ ] AWS アカウント（またはステージング用の領域）の用意、リージョンは `ap-northeast-1`
- [ ] Terraform を適用する人と権限（ブートストラップ用）。長期のアクセスキーをリポジトリや GitHub に置かない
- [ ] 状態の保管先（S3 + ロック）の作成（Bolt 2 の Step 3.1 で手順を示す）
- [ ] GitHub の Environments（`staging`、`production`）と、`AWS_ROLE_ARN` などの変数
- [ ] RDS for PostgreSQL 18 が、このリージョンとアカウントで利用できることの確認

## 用意したもの

| 種類                   | 場所                                                                                                                           | 検証したこと                                                                                                                                |
| :--------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| 本番用イメージ         | `apps/beer-game2/Dockerfile`                                                                                                   | `npm run container:check`（非 root、開発依存なし、マイグレーション、`/ready` 200・DB 停止で 503、鍵が無ければ起動に失敗、RDS の CA を信頼） |
| Terraform              | `apps/beer-game2/infra/`（`modules/`、`envs/staging/`）                                                                        | `terraform fmt -check`、`validate`（認証情報なし）。`plan` は未実施                                                                         |
| デプロイ・ロールバック | `apps/beer-game2/scripts/deploy/`、`.github/workflows/beer-game2-deploy-staging.yml`、`…-rollback-staging.yml`（手動起動のみ） | `shellcheck`、`actionlint`。AWS では未実行                                                                                                  |
| 動作確認               | `apps/beer-game2/scripts/smoke.ts`                                                                                             | ローカルで通過（`/ready`、1 ゲーム、SSE の受信）。デプロイ後は `API_URL` / `ORIGIN` にステージングの URL を渡す                             |
| CI                     | `.github/workflows/beer-game2.yml`                                                                                             | verify、e2e、container、infra、scripts の 5 ジョブ                                                                                          |

## 手順（人が行う）

AWS の認証情報は、**人が自分の端末で設定**する。AI は扱わない。各 `apply` の前に `plan` の差分（リソース、権限、公開範囲、費用）を確認する。

### 1. 状態の保管先（S3 + DynamoDB のロック）

```bash
ACCOUNT=<アカウント ID>; REGION=ap-northeast-1
aws s3api create-bucket --bucket beer-game2-tfstate-$ACCOUNT --region $REGION \
  --create-bucket-configuration LocationConstraint=$REGION
aws s3api put-bucket-versioning --bucket beer-game2-tfstate-$ACCOUNT --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket beer-game2-tfstate-$ACCOUNT \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket beer-game2-tfstate-$ACCOUNT \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws dynamodb create-table --table-name beer-game2-tfstate-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region $REGION
```

**注意**: Terraform の状態には、生成した秘密（DB のパスワード、資格の鍵など）が入る。このバケットへのアクセスを最小限にする。

### 2. Terraform の初期化と最初の適用

```bash
cd apps/beer-game2/infra/envs/staging
cp backend.hcl.example backend.hcl           # 値を入れる
cp terraform.tfvars.example terraform.tfvars  # 値を入れる
terraform init -backend-config=backend.hcl

# イメージが無いと ECS が起動できないため、先に ECR だけを作る
terraform apply -target=module.ecr
```

最初のイメージは、人の端末から ECR へ push する（ECR の URL は `terraform output ecr_repository_url`）。

```bash
cd apps/beer-game2
aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin <ECR のレジストリ>
docker build -t <ECR の URL>:initial .
docker push <ECR の URL>:initial
# ダイジェストを控える
aws ecr describe-images --repository-name beer-game2-staging --image-ids imageTag=initial \
  --query 'imageDetails[0].imageDigest' --output text
```

`terraform.tfvars` の `image` に `<ECR の URL>@sha256:<ダイジェスト>` を入れ、全体を適用する。

```bash
terraform plan -out=tfplan     # 差分を確認する
terraform apply tfplan
```

### 3. GitHub の設定

Environment `staging` を作り、次の**変数**（Variables。秘密ではない）を設定する。値は `terraform output` から得る。

| 変数                                      | 値                                           |
| :---------------------------------------- | :------------------------------------------- |
| `AWS_ROLE_ARN`                            | `deploy_role_arn`                            |
| `AWS_REGION`                              | `ap-northeast-1`                             |
| `ECR_REPOSITORY`                          | `beer-game2-staging`                         |
| `ECS_CLUSTER` / `ECS_SERVICE`             | `ecs_cluster` / `ecs_service`                |
| `API_TASK_FAMILY` / `MIGRATE_TASK_FAMILY` | `api_task_family` / `migrate_task_family`    |
| `WEB_BUCKET` / `DISTRIBUTION_ID`          | `web_bucket` / `distribution_id`             |
| `TASK_SUBNETS`（カンマ区切り）/ `TASK_SG` | `task_subnet_ids` / `task_security_group_id` |
| `STAGING_URL`                             | `url`                                        |

長期のアクセスキーは、GitHub に置かない（OIDC のロールを引き受ける）。

### 4. デプロイとロールバック

1. Actions の `beer-game2-deploy-staging` を手動で起動する。イメージのビルド → ECR → マイグレーション（失敗したら中止）→ ローリング更新（失敗したら自動で戻る）→ 静的ファイル → スモークテスト、の順に進む。
2. 動作を確認できたら、ワークフローの `push` トリガー（main へのマージ）を有効にする。
3. 戻すときは `beer-game2-rollback-staging` を起動する（戻す先のコミット SHA を指定できる）。マイグレーションは戻さない。
4. **初回の確認項目**: SSE が CloudFront と ALB を通って届くか（スモークテストの SSE）、Cookie（`Secure`、`SameSite=Strict`）と Origin の検査が正しく働くか、壊した版をデプロイして戻せるか。

## 既知の制約と未確認事項

- ステージングの CloudFront → ALB は HTTP（独自ドメインと ACM は B12）。ALB は CloudFront のアドレス範囲と、合言葉のヘッダーでのみ受ける。
- 費用の概算は未確認。RDS for PostgreSQL 18 がこのアカウント・リージョンで使えるかも未確認。
- `deploy.sh` / `rollback.sh` は AWS で未実行。履歴は S3 の `deployments/` に置く（ロールバックの候補）。
- 秘密情報の鍵の複数の版（ローテーション）は B4。
