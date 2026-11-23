---
type: Playbook
title: "観測の手順書 - beer-game-rust"
description: "メトリクス（EMF）、アラームの一覧と対応、ダッシュボード、心拍、未確認の項目。アラームの閾値は application の alarm_catalog と alarms.tf で同じ値。AWS 上の評価は未確認。"
tags: [operation, observability]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-23T00:00:00Z }
---

# 観測の手順書

> **状態: 定義のみ。メトリクスが CloudWatch に取り出されること、アラームの評価と通知は、AWS 上で未確認。** 閾値の表（`application` の `alarm_catalog`）は、`infra/modules/observability/alarms.tf` と同じ値で、食い違いは `app/tests/alarm_catalog.rs` が検出する。

## メトリクス

アプリは、CloudWatch の EMF（JSON 行）を標準出力へ出す。名前空間は `BeerGame/Rust`、ディメンションは `Environment`（環境変数 **`ENVIRONMENT`**）と、操作のあるものは `Operation`（OpenAPI の operationId）。ゲーム ID・表示名・資格は出ない。

| メトリクス | 出どころ |
| :--- | :--- |
| `RequestCount`・`RequestDurationMillis`・`ServerError`・`MainOperationSuccess` | 要求ごと（API） |
| `ConcurrencyConflict`・`RetryExhausted` | コマンドの試行ごと（追記の競合と、再試行の上限超過） |
| `DbPoolUtilizationPercent`・`TokioAliveTasks`・`PanicCount`・`RssBytes` | 60 秒ごと（`RssBytes` は **Linux のみ**） |
| `ProjectionMismatchGames`・`ProjectionLagGames`・`ProjectionUncheckedGames`・`ProjectionRebuildMillis` | `verify-projections`・`rebuild-projections` |
| `RetentionAbandonedGames`・`RetentionDeletedGames` | `retention` |

`PanicCount` は累計（再起動で 0 に戻る）。panic で、プロセスは落とさない（件数を数えるだけ）。

## アラームと対応

| アラーム | 意味 | まず確認すること |
| :--- | :--- | :--- |
| `main-operation-stall`（重大。研修中のみ） | 研修中に、主要な操作（作成・参加・保存・確定）が 1 分間成功していない | `/api/v1/ready`、api のタスク、DB の接続。直前のデプロイ |
| `synthetic-failure`（重大） | 合成監視（1 分ごとの `/api/v1/ready`）が失敗 | 同上 |
| `http-5xx-rate-warning`・`-critical` | 5xx の割合が 1%（5 分）・5%（1 分）超 | ログ（相関 ID）、DB、直前のデプロイ |
| `api-latency-p95-warning`・`-critical` | 応答の p95 が 800 ms・1 秒超 | DB の接続プール、タスクの CPU、ロックの待ち |
| `append-conflict-rate-warning`・`-critical` | 追記の競合率が 5%・20% 超 | 同時操作の集中。再試行の上限超過の有無 |
| `retry-exhausted-warning`・`-critical` | 再試行の上限超過（1 件・5 件以上） | 競合・**再構築中のロック待ち（`lock_timeout` 2 秒）** |
| `projection-mismatch`（重大） | 投影の行が、イベントから作り直した行と違う | `verify-projections` のログ。[再構築](./restore.md)の B |
| `projection-lag`（重大） | 進んだ版の記録が、イベントの最後の版と違う（**記録の追加前に作られたゲームでも出る**） | 再構築で記録が付く |
| `retention-abandoned`（重大） | 削除の再試行をやめたゲームがある | `retention` のログ、DB の権限 |
| `projection-verify-heartbeat`・`retention-heartbeat`（警告） | 結果のメトリクスが無い（日次・1 時間）= **定期タスクが動いていない** | Scheduler の状態、タスクの失敗（ログ）、`scheduled_tasks_enabled` |
| `db-pool-utilization-warning`・`-critical` | 接続プールの使用率が 70%・80% 超（10 分） | 取り残しの接続、遅い問い合わせ |
| `no-healthy-targets`・`task-cpu-critical` | 正常な対象が無い、タスクの CPU | api のタスク、デプロイの状態 |

## ダッシュボード

`infra/modules/observability`。応答時間と要求数、5xx と競合率、主要な操作の成功、再試行の上限超過と削除の放棄、投影の整合、接続プール、**実行環境（常駐メモリ・tokio のタスク数・panic の累計）**、合成監視、アラームの状態。

## 未確認・未実装

- **AWS 上の評価**: EMF のメトリクスへの取り出し、アラームの評価（欠測の扱い、期間の切り方）、通知（SNS）の配送。
- **メモリ（RSS）のアラーム**: 閾値は、コンテナのメモリを実測してから決める（いまはダッシュボードに出すだけ）。
- **panic のアラーム**: 閾値（1 件・5 件）は未決。
- **`idle in transaction` の件数**: メトリクスにしていない。
- **`retention` の最小権限**: アプリは、削除用のロール（`beergame_deleter`）へ切り替えない（接続のログインユーザーのまま動く）。**DB のログインロールの分離は未定義**（人の判断）。
- 心拍のアラームは、定期タスクが動く前提（動かなければ、心拍のアラームが鳴る）。
