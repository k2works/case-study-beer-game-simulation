---
type: Playbook
title: "本番の運用手順書 - beer-game-rust"
description: "本番の適用前の確認、デプロイとブルー/グリーン、定期タスク、再構築・検査の手動の実行、アラームの対応、インシデント。AWS には適用していない。"
tags: [operation, production]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-23T00:00:00Z }
---

# 本番の運用手順書

> **状態: 定義のみ。AWS に適用していない・一度も動かしていない。** ここに書く手順の実行結果は、すべて未確認。Terraform は、`infra/envs/production`。

## 適用前の確認（人が行う。必須）

適用の前に、次を人が確認し、結果を記録する（いずれも**未実施**）。

| # | 確認 | 備考 |
| :-: | :--- | :--- |
| 1 | AWS のアカウント・費用・IAM の判断（R10） | 範囲外の承認ゲート |
| 2 | Terraform 1.17 以上で `terraform plan` が通る | 手元は 1.5.7 のため、`validate` は複製（バージョン制約を外した状態）でだけ確認した |
| 3 | ドメインの Route 53 ホストゾーンが既にある | `modules/domain` は、ホストゾーンを作らない |
| 4 | GitHub の Environments（`staging`・`production`）と、その変数・保護ルール（本番は承認者を必須にする） | ワークフローは、設定しない。値は `terraform output` から |
| 5 | OIDC の信頼（`repo:<リポジトリ>:environment:<環境>`）と、環境の名前が一致する | |
| 6 | **タスク定義に `ENVIRONMENT`（staging または production）が入っている** | メトリクスのディメンション `Environment` と同じ値。無いと、アラーム・ダッシュボードが永久に欠測になる。**`local` または未設定だと、Cookie に `Secure` が付かない**（staging・production では付く。NF-S2） |
| 7 | タスクが `DB_HOST`・`DB_USER`・`DB_PASSWORD`・`CREDENTIAL_KEY` を受け取り、起動できる | アプリは、これらから接続 URL を組み立てる。**AWS 上の起動は未確認** |
| 8 | ステージングで、手動デプロイを 1 回成功させる | その後に、リポジトリの変数 `BEER_GAME_RUST_AUTO_DEPLOY` を `true` にする（[デプロイ](./deploy.md)） |
| 9 | 通知先（SNS の購読）とオンコールの体制 | 範囲外の承認ゲート |
| 10 | 研修のない時間に、`retention` と `verify-projections` が動く | 下の「定期タスク」 |

## 本番のデプロイ（ブルー/グリーン）

- 手動の起動だけ（`beer-game-rust-deploy-production`）。ステージングで検証したイメージを、**同じダイジェスト**で本番の ECR へ昇格する（ビルドしない）。環境の保護ルールで承認する。
- 更新方式は **ブルー/グリーン（ECS の組み込み。2026-11-23 にユーザーが承認）**。新しい版（green）を別の対象グループで起動し、健全を確かめてから切り替える。**待ち時間（bake）は 10 分**（初期案）。その間に、デプロイのアラームが鳴れば、自動で旧版へ戻す。**切り替えと戻しは AWS 上で未確認**。
- `no-healthy-targets` のアラームは、2 つの対象グループの正常数の最大を見る（片方が常に 0 でも、誤報しない）。
- デプロイの前に、手動のスナップショット（`<RDS>-pre-<SHA 8 桁>`）を取る。7 日より古いものは、ワークフローが消す。
- マイグレーションは、デプロイの一部（`migrate` タスク）。**戻さない**（[戻し](./rollback.md)）。

## 定期タスク（EventBridge Scheduler。再試行しない）

| タスク | 起動 | 結果 |
| :--- | :--- | :--- |
| `retention` | 5 分ごと（`rate(5 minutes)`） | 期限切れのゲームの削除。メトリクス `RetentionAbandonedGames`・`RetentionDeletedGames`（心拍） |
| `verify-projections` | 日次（`cron(0 18 * * ? *)`。UTC 18:00 = 日本時間 03:00。研修のない時間） | 投影の整合の検査。メトリクス `ProjectionMismatchGames`・`ProjectionLagGames`・`ProjectionUncheckedGames`（心拍） |

- 失敗は、**メトリクスの欠測（心拍のアラーム）で知る**。同じ起動を重ねて再試行しない。
- 定期タスクを止める: Terraform の `scheduled_tasks_enabled = false`（復元の切り替え中など）。
- 4 つのタスク定義（api・migrate・retention・verify-projections）は、デプロイのたびに**同じイメージ**へそろえる（ワークフローが行う）。

## 再構築・検査の手動の実行

```bash
# 検査（読み取りだけ。検査の後で取り消す）
aws ecs run-task --cluster <ECS_CLUSTER> --launch-type FARGATE --task-definition <verify_projections_task_family> \
  --network-configuration "awsvpcConfiguration={subnets=[<TASK_SUBNETS>],securityGroups=[<TASK_SG>],assignPublicIp=ENABLED}"
# 再構築（ゲーム ID を指定。省略は全ゲーム）。研修中は、先に進行役へ「停止」を依頼する（restore.md の B）
aws ecs run-task ... --task-definition <rebuild_projections_task_family> \
  --overrides '{"containerOverrides":[{"name":"rebuild-projections","command":["rebuild-projections","<ゲーム ID>"]}]}'
```

終了コード: 0 = 正常、1 = 不一致または失敗、64 = ゲーム ID の形が不正、70 = ゲームの一覧を読めない。

## アラームの対応

[観測の手順書](./observability.md) を参照。

## インシデント

1. 検知（アラーム）→ 運営者へ連絡（研修中は、進行役への停止の依頼を含む）。
2. 直前のデプロイが原因なら、[戻し](./rollback.md)。
3. データの破損なら、[復元](./restore.md)（**PITR の RPO は数分、RTO は未実測**）。
4. 事後に、時系列・根本原因・再発防止を記録する。
