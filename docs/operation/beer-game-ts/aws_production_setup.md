---
type: Reference
title: "AWS プロダクション環境セットアップ・運用手順書 - beer-game2"
description: "本番環境の構成、人が行う準備と手順、同じダイジェストでの昇格、ロールバック、鍵のローテーション、復元の訓練。コードと定義は用意したが、AWS では未実行・未検証。"
tags: [operation, setup]
status: draft
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-11T06:08:00Z }
---

# AWS プロダクション環境セットアップ・運用手順書（beer-game2）

本番環境の構築と運用の手順です。**コードと定義（Terraform、ワークフロー、スクリプト）は用意しましたが、AWS では実行も検証もしていません**（2026-11-11 の方針「コードと定義まで」。[Bolt 12 計画](../../development/beer-game2/bolt_12_plan.md)）。ステージングの手順は [AWS ステージング環境セットアップ手順書](./aws_staging_setup.md) を参照してください。

## 構成（ステージングとの違い）

| 項目               | ステージング            | 本番（`infra/envs/production`）                                                                                          |
| :----------------- | :---------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| データベース       | Single-AZ、削除保護なし | **Multi-AZ**（同期スタンバイ。RPO 0）、**削除保護**、削除時の最終スナップショット                                        |
| 自動バックアップ   | 7 日                    | 7 日（保持方針に「削除後も最大 7 日残る」と明記し、進行役の画面に表示）                                                  |
| API のタスク       | 1                       | **2**                                                                                                                    |
| ドメインと TLS     | CloudFront の既定       | **独自ドメインと ACM の証明書（us-east-1）、TLS 1.2 以上**（`TLSv1.2_2021`）。変数が無ければ `terraform plan` が失敗する |
| 秘密情報の復旧期間 | 0 日                    | 30 日                                                                                                                    |
| デプロイ           | コミットからビルド      | **ステージングで検証したダイジェストを昇格**（ビルドしない）                                                             |
| 承認               | なし                    | GitHub の `production` 環境の保護（必須のレビュアー）                                                                    |

観測（アラーム、合成監視、ダッシュボード、SNS）は、両環境で同じ `infra/modules/observability` を使います（[運用要件](../../design/beer-game2/operation.md)の「実装済みのアラーム」）。

## 人が行う準備（AI は認証情報を扱わない）

1. **独自ドメインの取得と DNS の管理者の決定**（未決事項 5）。
2. ACM（**us-east-1**）で証明書を発行し、DNS で検証する。
3. 通知先（`alert_email`）とオンコールの体制を決める（未決事項 6）。
4. GitHub に `production` 環境を作り、**必須のレビュアー**を設定する。変数（`AWS_ROLE_ARN`、`AWS_REGION`、`ECR_REPOSITORY`、`STAGING_ECR_REPOSITORY`、`ECS_CLUSTER`、`ECS_SERVICE`、`API_TASK_FAMILY`、`MIGRATE_TASK_FAMILY`、`WEB_BUCKET`、`DISTRIBUTION_ID`、`TASK_SUBNETS`、`TASK_SG`、`PRODUCTION_URL`）を設定する。
5. 本番の配置ロールに、ステージングの ECR からの読み取り（昇格のため）を許可する。

## 手順（人が行う）

### 1. 初回の構築

```bash
cd apps/beer-game2/infra/envs/production
cp backend.hcl.example backend.hcl            # 状態の保管先（ステージングと同じバケット、キーは production/）
cp terraform.tfvars.example terraform.tfvars  # ダイジェスト、ドメイン、証明書、通知先
terraform init -backend-config=backend.hcl
terraform plan    # 変更を人が確認する（本番は確認必須）
terraform apply
```

適用後、DNS で独自ドメインを CloudFront のディストリビューションへ向けます（`terraform output url`）。

### 2. デプロイ（同じダイジェストの昇格。AC6.2.2）

1. ステージングでデプロイし、スモークテストと確認を終える。そのイメージのダイジェスト（`sha256:...`）とコミット SHA を控える。
2. GitHub Actions の `beer-game2-deploy-production` を、ダイジェストとコミット SHA を入力して起動する。
3. `production` 環境のレビュアーが承認すると、イメージを**マニフェストを変えずに**本番の ECR へ写し、ダイジェストが一致することを検査してから、マイグレーション → ローリング更新 → 静的ファイル → スモークテストの順に進む。

### 3. ロールバック（AC6.2.3）

`beer-game2-rollback-production` を起動する（戻す先のコミット SHA は省略可。省略すると直前の成功した版）。イメージのダイジェストと静的ファイルの版を戻します。マイグレーションは戻しません（スキーマは、拡張 → 互換 → 縮小の順で、旧アプリと互換にしてあります。AC6.2.4）。ローリング更新の失敗は、ECS のサーキットブレーカーが自動で直前の版へ戻します。

**ブルー/グリーンは使いません**（[Bolt 12 計画](../../development/beer-game2/bolt_12_plan.md)の判断項目 1）。

### 4. 資格の鍵のローテーション

1. Secrets Manager の資格の鍵を、`CREDENTIAL_HMAC_KEYS`（`v1:<hex>,v2:<hex>`。最後が発行用）の形にし、新しい版を末尾に足す。
2. デプロイする（新しい資格は新しい版で発行され、旧版の資格も期限まで使える）。
3. 復帰コードの期限（30 日）が過ぎてから、旧版を外してデプロイする。

### 5. 保持の定期タスク

EventBridge Scheduler が 5 分ごとに `node dist/retention.js` を起動します。恒久的な失敗（5 回）は、アラーム `<name>-retention-permanent-failures` で通知されます。

### 6. 復元の訓練（AC6.2.5。四半期ごと、リリース前、バックアップの方針の変更時）

```bash
cd apps/beer-game2
AWS_REGION=ap-northeast-1 SOURCE_DB_INSTANCE=<本番の RDS の識別子> bash scripts/deploy/restore-drill.sh
```

スクリプトは、時点復旧で**新しいインスタンス**へ復元し（本番には触れない）、使えるようになるまでの秒数を出力して、訓練のインスタンスを削除します（`KEEP=1` で残す）。続けて人が、復元先で保持の定期タスクを実行して削除済みのゲームが残らないこと、最後の確定済みの週が残っていること（RPO 0）を確かめ、接続先の切り替えまでを含めた時間（RTO 15 分）を記録します。

| 日付       | 復元の時点 | 復元の所要（秒） | 切り替えまでの合計 | RPO の確認 | 実施者 |
| :--------- | :--------- | ---------------: | :----------------- | :--------- | :----- |
| （未実施） |            |                  |                    |            |        |

## 既知の制約と未確認事項

- **すべて AWS で未実行**: Terraform の適用、ワークフロー、昇格、ロールバック、復元の訓練、アラームの発報。
- ステージングの ECR から本番の ECR への写しに必要な権限は、まだ定義していない（人が行う準備 5）。
- Warning の通知と、DB・容量・セキュリティのアラームは未定義。
