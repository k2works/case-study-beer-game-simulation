---
type: Playbook
title: "本番の定義 - beer-game-scala"
description: "Terraform の構成（ネットワーク・ALB・ECS・RDS・秘密情報・独自ドメイン・TLS・セキュリティヘッダー・ブルー/グリーン・観測）、必要な変数、適用前の確認項目。AWS には適用していない。"
tags: [operation, production, terraform]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-27T11:00:00Z }
---

# 本番の定義

> **状態: 定義のみ。`terraform validate` は成功したが、`apply` は一度も実行していない。** AWS への適用は、人の承認が先。

## 構成

`apps/beer-game-scala/infra/`（[Kotlin 版](../beer-game-kotlin/production.md)を複製して適応した）。

| モジュール | 内容 |
| :--- | :--- |
| `network` | VPC・サブネット |
| `ecr` | イメージのリポジトリ |
| `rds` | PostgreSQL（本番は Multi-AZ・削除保護・最終スナップショット） |
| `secrets` | Secrets Manager（DB の資格、`BGS_CREDENTIAL_KEY`。値は Terraform が乱数で生成。**状態に入る**ので、状態のバケットを暗号化し、アクセスを制限する） |
| `alb` | 負荷分散（ブルー/グリーンの 2 つの対象グループ） |
| `ecs` | Fargate の API サービス、1 回限りのタスク（migrate）、定期タスク（retention・verify） |
| `web` | 静的ファイル（S3 + CloudFront）、セキュリティヘッダー |
| `domain` | ACM の証明書（us-east-1。DNS 検証）と Route 53 の別名 |
| `observability` | アラーム・ダッシュボード・合成監視・通知（SNS）。[観測](./observability.md) |
| `github_oidc` | GitHub Actions の OIDC（長期のキーを持たない） |

環境は `envs/staging`・`envs/production`。

## 必要な変数（本番）

`github_repository`・`image`（ステージングで検証したダイジェスト）・`web_bucket_name`・`domain_name`・`hosted_zone_id`・`create_oidc_provider`、通知先（`critical_alarm_emails`・`warning_alarm_emails`）。例: `terraform.tfvars.example`。状態の保管先: `backend.hcl.example`（暗号化・バージョニングのあるバケットを人が作る）。

## 検証（適用しない）

Terraform 1.17 以上が要る（`required_version`）。ローカルが古ければ Docker で: `docker run --rm -v "$PWD:/work" -w /work/envs/production --entrypoint sh hashicorp/terraform:1.17 -c "terraform init -backend=false && terraform validate"`。**2026-11-27 に staging・production とも成功**（B14）。

## 適用前の確認項目（**未確認**）

1. **機能しないアラーム**: アプリが出している指標は、要求ごとの EMF（`Http5xxRate`・`ResponseTime`・`RequestCount`）と、定期タスクの結果（`RetentionAbandonedGames`・`StreamMismatchGames`）だけ。`MainOperationSuccess`・`AppendConflictRate`・`JvmHeapUsedPercent`・`DbPoolUtilizationPercent`・`RetryExhausted` などを使うアラームは、**指標が出るまで機能しない**。欠測を「異常」と扱うもの（`main-operation-stall`）は、指標が無いと**誤報になる**。適用前に、指標を出すか、アラームを無効にする。
2. **削除用のロール**: 保持削除は、所有者の接続（`DB_USER`）で動く。追記専用のロール（V003）は DELETE を持たない。本番で、削除専用のロールに分けるか判断する。
3. **観察者専用の DB ロール・接続プールの分離**は未実装（B9）。
4. **アラームの閾値**は仮置き（未計測）。`Alarms`（アプリ）と `alarms.tf` は、`AlarmTerraformSpec` が一致を検査する。
5. **JVM のヒープ・起動時間**: コンテナの起動は、ローカルで約 18〜23 秒（5 回。Docker Desktop）。AWS の Fargate での値は未測定。
6. **CSP**: フロントエンド（共有の `beer-game-web`）が満たすかは未確認。
7. **コスト**: 見積もりは未実施。
