---
type: Reference
title: "AWS ステージング環境セットアップ手順書（骨子） - beer-game2"
description: "ステージング環境の構成、費用の概算（未確認）、人が行う準備、Terraform の適用順序。Bolt 2 の骨子。"
tags: [operation, setup]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-10T04:55:00Z }
---

# AWS ステージング環境セットアップ手順書（骨子）

Bolt 2（[計画](../../development/beer-game2/bolt_2_plan.md)）で、実際の手順に育てる。現時点では**骨子と、費用の概算**だけで、AWS には何も作っていない。

## 構成（ステージング）

[インフラ設計](../../design/beer-game2/architecture-infrastructure.md)から、費用を抑える次の差分を提案する。本番の構成は B12 で設計どおりにする。

| 要素 | 設計（本番） | ステージング（提案） |
| :--- | :--- | :--- |
| RDS for PostgreSQL 18 | Multi-AZ、削除保護 | Single-AZ、PITR あり、削除保護なし |
| API（ECS Fargate） | 常時 2 タスク、2〜4 に自動増減 | 1 タスク、ローリング更新 |
| ネットワーク | プライベートサブネット + NAT または VPC エンドポイント | タスクは公開サブネット（セキュリティグループで ALB からのみ許可）、RDS はプライベート |
| 配信 | CloudFront + 独自ドメイン（ACM） | CloudFront の既定のドメイン（独自ドメインは B12） |

## 費用の概算（要確認）

**公式の料金表では確認していない概算**（東京リージョン、1 ドル = 為替未換算、月額、2026-11 時点の記憶に基づく）。実際の見積もりは、人が AWS Pricing Calculator で確認する。

| 項目 | 概算（月額） | 備考 |
| :--- | ---: | :--- |
| RDS db.t4g.micro、Single-AZ、20 GB | 約 $20 | インスタンスの種類は負荷試験（B13）で見直す |
| ECS Fargate 0.25 vCPU / 0.5 GB × 1 | 約 $10 | 常時起動 |
| ALB | 約 $20〜25 | 時間料金 + LCU |
| CloudFront / S3 / ECR / CloudWatch Logs | 約 $5 | 少量の利用 |
| Secrets Manager（約 4 件） | 約 $2 | 1 件 $0.4 |
| **合計（ネットワーク費用なし）** | **約 $55〜65** | |
| 参考: NAT ゲートウェイを追加 | +約 $45 | プライベートサブネットのタスク用 |
| 参考: VPC エンドポイント（ECR、Logs、Secrets など） | +約 $40〜60 | NAT と同程度。「NAT なし」で安くならない |

使わない時間にタスクと DB を停止すれば、さらに下げられる。

## 人が行う準備（AI は認証情報を扱わない）

- [ ] AWS アカウント（またはステージング用の領域）の用意、リージョンは `ap-northeast-1`
- [ ] Terraform を適用する人と権限（ブートストラップ用）。長期のアクセスキーをリポジトリや GitHub に置かない
- [ ] 状態の保管先（S3 + ロック）の作成（Bolt 2 の Step 3.1 で手順を示す）
- [ ] GitHub の Environments（`staging`、`production`）と、`AWS_ROLE_ARN` などの変数
- [ ] RDS for PostgreSQL 18 が、このリージョンとアカウントで利用できることの確認

## 適用順序（予定）

1. 状態の保管先（ブートストラップ。人が実行）
2. `network` → `ecr` → `secrets` → `rds`
3. `iam`（GitHub の OIDC）
4. `ecs` → `alb` → `web`（S3 + CloudFront）
5. パイプライン（GitHub Actions）からのデプロイ

各 `terraform apply` の前に、`plan` の差分（リソース、権限、公開範囲、費用）を人が確認する。
