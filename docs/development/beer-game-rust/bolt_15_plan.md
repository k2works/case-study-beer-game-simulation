---
type: Plan
title: "Bolt 15 計画 - 本番の定義（Rust 版）"
description: "beer-game-rust の Bolt 15（Unit U5 の最後）のステップ計画。アプリのセキュリティヘッダー、デプロイ・戻しのワークフロー、復元の手順（PITR スクリプト）、N-1 互換の確認、運用手順書、本番の定義の検査。AWS には適用しない。RPO・RTO の範囲の決定が前提。人の承認待ちの草案。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-23T00:00:00Z }
---

# Bolt 15 計画 - 本番の定義（Rust 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B15（[リリース計画](./release_plan.md)）。U5 の最後 |
| 所要（計画） | 3 稼働日（仮定） |
| ゲート密度 | **密**（本番のデプロイ・復元・セキュリティに関わるため。ステップごとに人が検証） |
| 状態 | **2026-11-23 にユーザーが「承認」（計画と判断項目 1〜11 を、書かれたとおりに。RPO・RTO は提案どおり区別する（RPO 0 と RTO 15 分は Multi-AZ のフェイルオーバーに約束し、PITR は破損・誤操作向けで RPO は数分、RTO は実測後）。ブルー/グリーンは ECS の組み込み）。着手済み** |

> **AWS への適用はしません**（Terraform・ワークフロー・スクリプト・手順書の「定義」まで。適用は人の別ゲート。リスク R10）。

### ゴール

本番へ出し、戻し、復元できる**定義**が揃い、AWS の適用の判断を待つだけの状態にする。定義は、検査できる形（ファイルを読んで期待と突き合わせる試験、復元スクリプトのドライラン）で書く。**「定義がある」ことと「動く」ことは別で、AWS 上の動作は未確認と明記する。**

### 確認したい仮説（リリース計画より）

本番へ出し、戻し、復元できる定義か。

## 現状の確認（読み取りで確かめた事実）

- **Terraform は、すでにかなり揃っている**: `infra/modules/domain`（ACM・Route 53）、`ecs`（定期タスク `retention`・`verify-projections`（EventBridge Scheduler）、`deployment_strategy` の `ROLLING`／`BLUE_GREEN`）、`rds`（`backup_retention_period = 7`、本番は Multi-AZ・削除保護）、`web`（CloudFront。`Permissions-Policy`）、`observability`（B14）。本番の環境（`envs/production/main.tf`）は、`domain` を使い、`deployment_strategy = "BLUE_GREEN"`。
- **ステージング・本番のデプロイと戻しのワークフローは無い**（`.github/workflows` は `beer-game-rust.yml`（CI）だけ。Kotlin 版には `beer-game-kotlin-deploy-staging/production`・`rollback-staging/production` がある）。
- **復元の手順（PITR スクリプト）と N-1 互換の確認スクリプトは無い**（Kotlin 版に `scripts/restore-pitr.sh`・`n1-compat.sh` がある。Rust 版は `container-smoke.sh` だけ）。
- **運用手順書が無い**（`docs/operation/beer-game-rust/` は索引のみ。環境セットアップ手順書は「未作成」）。
- **アプリのセキュリティヘッダーが無い**（`crates/` に CSP・HSTS などの出力が無い）。共有する `features/` の `@api` のうち、**許可リストの外の 5 件**がこの Bolt に関わる: セキュリティヘッダー（`security-baseline.feature`）、構造化ログに秘密を含まない（`security-baseline.feature`・`observability.feature`）、DB に接続できないときの準備の失敗（`observability.feature`）。残り 1 件は、Rust 版に無い JVM のシナリオ。
- **B13・B14 から引き継ぐもの**: N-1 互換の確認（旧版が書いたイベントを今のコードで読む）、`ENVIRONMENT` 環境変数のタスク定義への設定、定期タスクが心拍のアラームの前提、メモリ（RSS）の実測とアラームの閾値。

## 対象の受入条件

| 対象 | 内容 | 確認の方法 |
| :--- | :--- | :--- |
| AC6.2.* | 本番へ出す・戻す・復元する（定義まで）。セキュリティヘッダー、TLS | 共有 feature の `@api`（セキュリティヘッダー）、定義の検査（`production_definition` のテスト）、復元スクリプトのドライラン |
| NF-S9・NF-S15 | TLS 1.2 以上、セキュリティヘッダー | 同上 |
| NF-O11 | 自動デプロイ（ステージング）、直前の版へ戻せる、書く版は読める版の展開後 | ワークフローの定義の検査、N-1 の確認 |
| NF-R3・NF-R4 | RPO 0（確定済み週）・RTO 15 分 | **机上確認**（RPO・RTO の範囲の決定が前提） |
| NF-O1・NF-O10 | 構造化ログに秘密を含まない、準備のヘルスチェック | 共有 feature（許可リストへ） |

## 着手前に人の判断が要る項目

| # | 項目 | 案 |
| :-: | :--- | :--- |
| 1 | **RPO・RTO の約束の範囲（R9。前提）** | **提案: 「確定済みの週の RPO 0」は、Multi-AZ のフェイルオーバー（同期レプリカ）に対して約束する。PITR（時点復旧）では RPO 0 にならない（復元できる最新時刻が数分遅れる）ので、PITR は「リージョン・データの破損」向けの手順とし、RPO の約束は数分、RTO 15 分は Multi-AZ のフェイルオーバーに対して約束する。PITR の RTO は実測が要る（新しいインスタンスの作成に 15 分で収まる保証がない）**。この区別を、人が決める |
| 2 | **ブルー/グリーンの方式** | Terraform は ECS の組み込み（`BLUE_GREEN`）を既に定義済み（設計書は CodeDeploy 案）。**提案: 組み込みを採る**（CodeDeploy のアプリ・デプロイグループ・appspec が要らず、`update-service` でタスク定義を指定する既存のワークフローの形が変わらない）。代替は CodeDeploy。ステージングはローリング |
| 3 | **セキュリティヘッダー** | アプリが全応答（成功・拒否・存在しない経路）に付ける: `Content-Security-Policy`・`Strict-Transport-Security`・`X-Content-Type-Options: nosniff`・`Referrer-Policy`・`Cache-Control`。**値は Kotlin 版の実装に合わせる**（`Observability.kt`）。CloudFront 側の `Permissions-Policy` は既存。HSTS の max-age の整合を検査する。**実ブラウザでの CSP の確認は未実施**（Web の CSP は、ソースに `style=`・`<style>` が無いことの静的な確認まで） |
| 4 | **ステージングの自動デプロイ** | `workflow_run`（`main` の CI `beer-game-rust` の成功後）で起動。**リポジトリ変数 `BEER_GAME_RUST_AUTO_DEPLOY` が `'true'` のときだけ**動く（未設定の間は、起動してもジョブを飛ばす）。人が AWS の準備を終え、手動で 1 回成功させてから設定する。**本番は自動にしない**（`workflow_dispatch` のみ。環境の保護ルールで承認）。**シークレット・環境の保護は未設定**（人が行う） |
| 5 | **デプロイ前のスナップショット** | 本番のデプロイの、マイグレーションの前に、手動のスナップショット（`<RDS>-pre-<SHA 8 桁>`）を取る（復元点）。手動のスナップショットは自動で消えないので、**7 日より古いものをワークフローで消す**（削除したゲームのデータが、バックアップに最大 7 日を超えて残らない。NF-S16） |
| 6 | **復元の手順** | `scripts/restore-pitr.sh`（Kotlin 版と同じ形。既定はドライラン。`--execute` で新しいインスタンスへの復元と完了待ちだけ。**切り替えは人**）。手順書 `restore.md`。復元後の整合検査（`retention` → `verify-projections`）と、再構築では周辺ストア・削除の進行が復元されない旨 |
| 7 | **N-1 互換の確認** | `scripts/n1-compat.sh`（前のリリースのイメージで書いたイベントを、今のコードで読めるか）。**CI の必須ジョブへの追加は、守りの導入計画（別計画・承認待ち）の範囲**。B15 では**手元で実行できる形**まで |
| 8 | **書く版の切り替え（スキーマの版を上げるとき）** | **提案: 環境変数 `WRITE_SCHEMA_VERSION`（タスク定義の環境）**。変更は本番の環境変数の変更なので承認ゲートに乗り（ブルー/グリーンで、新しい設定の版が旧版と並んで起動し、待ち時間の間に戻せる）、設定サービスを増やさない。**実装はしない**（現行の版は 1 で、上げる予定がない） |
| 9 | **契約・DDL・画面の変更** | **なし**（`openapi.yaml`・マイグレーション・Web は触らない） |
| 10 | **新規依存** | なし（見込み） |
| 11 | **KMS・DB ログインロールの分離・プライベートサブネット** | **定義しない**（人の判断が要る。R10） |

## ステップ計画（各ステップの終わりで人のゲート）

1. **読み取り**: Kotlin 版の B14（`Observability.kt` のセキュリティヘッダー、`.github/workflows/beer-game-kotlin-*.yml`、`scripts/restore-pitr.sh`・`n1-compat.sh`、`ProductionDefinitionSpec`、運用手順書 `production.md`・`restore.md`・`deploy.md`・`rollback.md`）と、Rust 版の `infra/` の差を一覧にする。
2. **判断項目の承認（人のゲート）**: 上の 1〜8（特に **1 の RPO・RTO の範囲**）。
3. **Red（先に書く）**: 共有 feature のうち、セキュリティヘッダー・構造化ログ・準備の失敗の 4 シナリオを許可リストへ。受入のステップ（未定義）で失敗を確かめる。定義の検査（ワークフロー・スクリプト・Terraform・手順書の存在と内容）を、先に書いて失敗を確かめる。
4. **アプリのセキュリティヘッダー**: 全応答（成功・拒否・存在しない経路）に付ける。HSTS・CSP などの値を、Kotlin 版と CloudFront 側と整合させる。
5. **ワークフロー**: `beer-game-rust-deploy-staging.yml`・`deploy-production.yml`・`rollback-staging.yml`・`rollback-production.yml`。4 つのタスク定義（api・migrate・retention・verify-projections）を同じイメージへそろえる。デプロイ前のスナップショットと、古いスナップショットの削除。**シークレット・環境の保護は設定しない**（人が行う）。
6. **復元と N-1**: `scripts/restore-pitr.sh`（ドライランの出力を検査）、`scripts/n1-compat.sh`。
7. **運用手順書**: `docs/operation/beer-game-rust/` に `production.md`（適用前の確認、本番のデプロイ・戻し、定期タスク、アラームの対応、インシデント）、`restore.md`（復元・RPO/RTO・訓練の様式）、`deploy.md`・`rollback.md`・`observability.md`、索引の更新。**RPO・RTO の机上確認の結果を書く**。
8. **定義の検査**: Terraform（`validate`。手元の版の制約に注意）、ワークフローの YAML の構文、タスク定義の `ENVIRONMENT` 環境変数、`retention` の 5 分・`verify-projections` の日次、本番の `BLUE_GREEN`・Multi-AZ・削除保護、TLS 1.2 以上。
9. **品質ゲート・記録**: `just backend-check`、`just acceptance`、`just ui-acceptance`（**Node 26 で実行**）。`bolt_15_report.md`、`index.md`、`mkdocs.yml`、`docs/log.md`、`okf:check`。
10. **コミット・push・CI**（区切りごと）。

## 範囲外

AWS への適用・`plan`・実環境の確認、シークレット・環境の保護ルールの設定、守りの導入（hook・必須ジョブ。別計画）、NF-P18 の最適化、メモリのアラームの閾値（実測後）、panic の方針、`WRITE_SCHEMA_VERSION` の実装。

## リスク

| # | リスク | 対応 |
| :--- | :--- | :--- |
| R1 | RPO 0 を PITR に対して約束してしまう（PITR では成り立たない） | 判断項目 1 を先に決める。手順書に、どの障害にどの手段で何を約束するかの表を書く |
| R2 | ブルー/グリーンの切り替えで、`no-healthy-targets` のアラームが誤報する（対象グループが 2 つ） | B14 の定義は 2 つの対象グループの最大を見る（`observability` の実装）。定義の検査で確かめる。**AWS 上は未確認** |
| R3 | ワークフローが、定期タスクの family を置き去りにして、旧イメージのまま動く | 4 つの family を同じイメージへそろえる手順を、定義の検査で確かめる |
| R4 | セキュリティヘッダーの CSP が、Web の実ブラウザの動作を壊す | Kotlin 版と同じ値。ソースの静的な確認まで。**実ブラウザの確認は未実施と明記** |
| R5 | 復元スクリプトが AWS 上で動かない（未確認） | ドライランの出力を検査する。`--execute` は、人が復元の訓練で初めて実行する |
| R6 | 手元の Terraform が古く（1.5.7）、実環境の版（1.17 以上）の `validate`・`plan` を確認できない | 複製での `validate` までを記録し、`plan` は未実施と明記 |

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-23 | 初版作成（草案。人の承認待ち。RPO・RTO の範囲の決定が前提） | claude-code |
