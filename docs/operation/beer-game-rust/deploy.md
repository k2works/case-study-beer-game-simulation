---
type: Playbook
title: "デプロイの手順書 - beer-game-rust"
description: "ステージングの自動デプロイと本番の手動デプロイ、必要な GitHub の変数、イメージのダイジェスト固定、スモークテスト、履歴。AWS では未実行。"
tags: [operation, deploy]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-23T00:00:00Z }
---

# デプロイの手順書

> **状態: 定義のみ。ワークフローは AWS で一度も実行していない（YAML の構文と、`app/tests/production_definition.rs` の検査だけ）。**

## ワークフロー

| ワークフロー | 起動 | 環境 |
| :--- | :--- | :--- |
| `beer-game-rust-deploy-staging` | 手動、または `main` の CI（`beer-game-rust`）の成功後の自動 | `staging` |
| `beer-game-rust-deploy-production` | **手動だけ**（環境の保護ルールで承認） | `production` |
| `beer-game-rust-rollback-staging`・`-production` | 手動だけ | 同上（[戻し](./rollback.md)） |

## 自動デプロイを有効にする（人が行う）

自動の起動は、**リポジトリの変数 `BEER_GAME_RUST_AUTO_DEPLOY` が `'true'` のときだけ**動く（未設定の間は、起動してもジョブを飛ばす）。さらに、CI が成功したコミットの変更（最初の親との差）に、このアプリ・共有の画面/契約/受け入れ条件・このデプロイのワークフローが含まれないとき（設計書・文書だけの変更）は、デプロイしない（`changes` ジョブ。手動起動は判定しない）。次の順で行う:

1. AWS の準備（Terraform の適用、OIDC、環境の変数）を終える（[本番の適用前の確認](./production.md)）。
2. `beer-game-rust-deploy-staging` を、手動で 1 回成功させる。
3. `BEER_GAME_RUST_AUTO_DEPLOY` を `true` にする。

**本番は自動にしない。**

## 必要な変数（Settings > Environments > `<環境>` の Variables。値は `terraform output` から。ワークフローに値を書かない）

| 変数 | 出どころ |
| :--- | :--- |
| `AWS_ROLE_ARN` | `deploy_role_arn` |
| `AWS_REGION` | リージョン |
| `ECR_REPOSITORY` | `ecr_repository_url` の最後の部分 |
| `ECS_CLUSTER`・`ECS_SERVICE` | `ecs_cluster`・`ecs_service` |
| `API_TASK_FAMILY`・`MIGRATE_TASK_FAMILY` | `api_task_family`・`migrate_task_family` |
| `RETENTION_TASK_FAMILY`・`VERIFY_TASK_FAMILY` | `retention_task_family`・`verify_projections_task_family` |
| `WEB_BUCKET`・`DISTRIBUTION_ID` | `web_bucket`・`distribution_id` |
| `TASK_SG`・`TASK_SUBNETS` | `task_security_group_id`・`task_subnet_ids`（カンマ区切り） |
| `STAGING_URL`（ステージングのみ） | `url`（スモークテストの宛先） |

## 順序

ビルド → ECR への push → 新しいタスク定義の登録（api・migrate・retention・verify-projections を同じイメージへ）→ `migrate`（1 回限りのタスク。失敗したら中止）→ api の更新 → 静的ファイルの公開 → スモークテスト（`/api/v1/ready`・`/api/v1/health`）→ 履歴の記録。失敗したら、直前の版へ自動で戻す。

- イメージは、コミット SHA のタグで ECR へ push し、以降は**ダイジェスト**で固定する。本番へは、ステージングで検証した**同じダイジェスト**を昇格する。
- 画面（`web/`）は Kotlin 版と共有する（`apps/beer-game-web`。2026-11-23 に Kotlin 版のディレクトリから移動）。静的ファイルは、`releases/<SHA>/` に置き、`current/` に反映する。
- 自動確定を含む業務のスモークテストは未実装（未確認）。

## 書く版の切り替え（スキーマの版を上げるとき）

旧版が、新しいイベントを読めなくなると、戻しが効かなくなる。**読める版を先に展開し、書く版は次のリリースで切り替える**（2 段階）。リリース前に、`apps/beer-game-rust/scripts/n1-compat.sh <直前のリリース>` で、直前のリリースの読み取り側が、現在の版が書くイベントを読めることを確かめる（**手元で実行する。CI の必須ジョブにはしていない**）。書く版の切り替えの方法（環境変数 `WRITE_SCHEMA_VERSION` を、ブルー/グリーンで展開する案）は、**まだ実装していない**（現行の版は 1 で、上げる予定がない）。
