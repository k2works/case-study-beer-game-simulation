---
type: Playbook
title: "観測の運用手順書 - beer-game-kotlin"
description: "メトリクス（EMF）、アラーム、ダッシュボード、合成監視、通知（SNS）の定義と、アラーム発報時の初動、研修中のアラームの切り替え、アラームの訓練の実行方法。Terraform は定義のみで、AWS には未適用。"
tags: [operation, observability, alarm]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-17T23:00:00Z }
---

# 観測の運用手順書

> **状態: 定義のみ。AWS には適用していない。** メトリクスの出力・アラームの評価・訓練は、ローカルで検証した。CloudWatch・SNS・Synthetics での動作は未確認。設計は [運用要件](../../design/beer-game-kotlin/operation.md) の「監視設計」。計画と結果は [Bolt 13 計画](../../development/beer-game-kotlin/bolt_13_plan.md)・[終了報告](../../development/beer-game-kotlin/bolt_13_report.md)。

## 構成

| 要素 | 定義の場所 | 内容 |
| :--- | :--- | :--- |
| メトリクス | `adapter-http` の `EmfMetricSink`、`application` の `Metrics.kt`・`JvmReading.kt` | CloudWatch の EMF の JSON 行を標準出力へ。名前空間 `BeerGame/Kotlin`。ディメンションは `Environment`（と、操作のあるものは `Operation`）。ログドライバが CloudWatch Logs へ送り、CloudWatch が取り出す |
| アラームの表 | `application` の `AlarmCatalog` | 設計書の閾値。評価の関数 `evaluateAlarms` と、訓練の関数 `detectionDelay`（模擬の時計） |
| アラームの定義 | `infra/modules/observability/alarms.tf` | 表と同じ値（食い違いは `ObservabilityDefinitionSpec` が検出する） |
| 通知 | `infra/modules/observability/main.tf` | SNS のトピックを重大・警告の 2 つ。メールの購読は変数 `critical_alarm_emails`・`warning_alarm_emails` |
| 合成監視 | 同上、`canary/ready.js` | 1 分ごとに `/api/v1/ready` を取得（CloudWatch Synthetics）。**業務の操作は呼ばない** |
| ダッシュボード | 同上 | 応答時間、5xx・競合率、主要な操作の成功、再試行の上限超過、投影の整合、JVM、合成監視、アラームの状態 |

## 出力されるメトリクス

| メトリクス | 出どころ | 意味 |
| :--- | :--- | :--- |
| `RequestDurationMillis`、`RequestCount`、`ServerError`（0/1） | すべての HTTP 要求（操作ごと） | 応答時間、要求数、5xx（平均が 5xx の割合） |
| `MainOperationSuccess` | 主要な操作（`createGame`・`joinGame`・`saveDecision`・`commitWeek`）の成功。1 秒の解像度 | 研修中の停止の検知 |
| `ConcurrencyConflict`（0/1）、`RetryExhausted` | コマンドの試行ごと | 追記の競合率（自動再試行の前）、再試行の上限超過 |
| `ProjectionMismatchGames`、`ProjectionLagGames`、`ProjectionUncheckedGames` | `verify-projections` の終了時 | 投影の不一致・版の遅れ・検査できなかったゲームの数 |
| `RetentionAbandonedGames`、`RetentionDeletedGames` | `retention` の終了時 | 再試行をやめた削除・完了した削除の数 |
| `JvmHeapUsedPercent`、`JvmGcPauseMillis`、`DbPoolUtilizationPercent` | 60 秒ごとの読み取り | ヒープの使用率、GC の 1 回あたりの停止（区間の平均。p99 ではない）、接続プールの使用率 |

**未実装（設計にあるが、この版では出力しない）**: SSE の接続数と通知の遅延（API に SSE が無い）、再生したイベント数と時間・投影の更新時間（永続化の内部）、イベントの読み込み失敗（500 の一部として現れる）、削除の期限超過の経過時間、`DecisionConflict` の件数（ログの結果コード `session.decision_conflict` で代用）。

## アラームと初動

重大は即時の対応、警告は担当者の確認。ランブック全体は [運用要件](../../design/beer-game-kotlin/operation.md) の「障害対応」。

| アラーム（`<name>-` の後ろ） | 重大度 | 条件 | 初動 |
| :--- | :--- | :--- | :--- |
| `main-operation-stall` | 重大（研修中のみ） | 主要な操作の成功が 10 秒 x 5 期間（約 1 分）0 | `/api/v1/ready` と ECS のタスクを確認する。ALB の `no-healthy-targets` も鳴っていれば、タスクの停止。運営者へ連絡する |
| `synthetic-failure` | 重大 | 合成監視の失敗（最悪 2 分で検知） | 同上。外側（CloudFront・ALB）の経路も確認する |
| `no-healthy-targets` | 重大 | 正常なタスクが 0（1 分） | ECS のサービスのイベントとタスクの停止理由を確認する |
| `http-5xx-rate-warning` / `-critical` | 警告 / 重大 | 5xx が 1%（5 分）/ 5%（1 分） | 直近のデプロイを確認し、必要ならロールバックする（[ロールバック手順書](./rollback.md)） |
| `api-latency-p95-warning` / `-critical` | 警告 / 重大 | p95 が 800 ms / 1 秒（5 分） | DB の CPU・接続プール・GC を確認する |
| `append-conflict-rate-warning` / `-critical` | 警告 / 重大 | 競合率が 5% / 20%（5 分。提案） | 設計書の障害対応 14（進行役へ、同時保存を避け「進行役が確定」へ切り替える依頼） |
| `retry-exhausted-warning` / `-critical` | 警告 / 重大 | 1 件超 / 5 件以上（5 分） | 利用者に失敗が見えている。競合の集中するゲームを特定する |
| `projection-mismatch`、`projection-lag` | 重大 | 日次の検査で、不一致・版の遅れが 1 ゲームでも | 該当ゲームを確認し、研修の無い時間に `rebuild-projections <ゲーム ID>` を実行する（周辺ストア・削除の進行は復元されない） |
| `retention-abandoned` | 重大 | 削除の再試行の上限に達したゲームがある | 失敗コードを確認し、原因を直してから再試行する（設計書の障害対応 7） |
| `retention-heartbeat` | 警告 | `retention` の結果のメトリクスが 1 時間無い（B14） | `retention` の定期タスクが動いていない。[本番の運用手順書](./production.md) の 6 |
| `projection-verify-heartbeat` | 警告 | 日次の検査の結果のメトリクスが 1 日無い（B14） | `verify-projections` の定期タスクが動いていない。同上 |
| `jvm-heap-*`、`jvm-gc-pause-*`、`db-pool-utilization-*` | 警告 / 重大 | 設計書のとおり | 負荷・タスクのサイズ・接続プールを確認する |
| `task-cpu-critical` | 重大 | ECS タスクの CPU が 80%（10 分） | タスク数・サイズを確認する |

## 研修中のアラームの切り替え

`main-operation-stall` は、研修のない時間は操作が無くて当然なので、**研修中だけ通知する**。Terraform の変数 `training_alarms_enabled`（既定 false）で、アラームの通知（`actions_enabled`）を切り替える。研修の開始前に true、終了後に false にして適用する。**この切り替えの自動化（運営者の予定表との連携）は未実施**で、人が行う（運用の予定表の未決と共通）。

## アラームの訓練（ローカルの模擬）

実際の待機はせず、模擬の時計で、故障を模擬したメトリクスをアラームの評価に与える。

```bash
cd apps/beer-game-kotlin
./gradlew :application:test --tests '*AlarmsSpec*'              # 評価の意味と訓練（停止、競合率、5xx、ヒープ ほか）
./gradlew :app:acceptanceTest --tests '*RunAcceptanceTests*'    # features/operations/metrics-and-alarms.feature
./gradlew :app:test --tests '*ObservabilityDefinitionSpec*'     # 表と Terraform の一致
```

結果（模擬）: 研修中に 5 秒ごとの成功が途絶えたとき、`main-operation-stall` は停止の 50〜59 秒後に発報する（最悪でも 60 秒以内）。合成監視（1 分ごと）の失敗は、最悪 119 秒で発報する（1 分では保証できない）。通知（SNS・メール）の配送の時間は含まない。

## 適用の前に（AWS 未適用のため、人が確かめる項目）

- `terraform init`（`archive` プロバイダーが加わるので、ロックファイルの更新）、`terraform validate`・`plan`。環境の `required_version` は 1.17 以上。**手元は 1.5.7 で、モジュール単体の `validate` だけ実施した**。
- Synthetics のランタイムの版（既定 `syn-nodejs-puppeteer-9.1`）、カナリアのスクリプトの動作、カナリア名（21 文字まで）。
- SNS のメールの購読は、宛先が確認のメールを承認するまで有効にならない。
- 高解像度（1 秒）メトリクスと 10 秒のアラームの費用。
- `retention`・`verify-projections` の ECS の定期タスクとスケジュールは、B14 で Terraform に定義した（[本番の運用手順書](./production.md)）。定期タスクが止まったことは、B14 の心拍のアラーム（`retention-heartbeat`・`projection-verify-heartbeat`。欠測を超過とみなす）で知る。**ただし、AWS では未確認**。
- 本番のブルー/グリーンでは、`no-healthy-targets` は 2 つの対象グループの正常数の最大を見る（B14）。
