---
type: Playbook
title: "観測 - beer-game-scala"
description: "メトリクス（EMF）、アラームの閾値の表、出ていない指標、通知。AWS には未適用。"
tags: [operation, observability]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-27T11:00:00Z }
---

# 観測

> **状態: 定義のみ（AWS 未適用）。一部の指標は、アプリがまだ出していない。**

## アプリが出している指標

標準出力へ、1 件の要求につき、構造化ログ 1 行と EMF 1 行（名前空間 `BeerGame`。次元 `Environment`・`Operation`、および環境だけの合計）。

| 指標 | 内容 |
| :--- | :--- |
| `ResponseTime`（ms） | 応答時間 |
| `RequestCount` | 要求数 |
| `Http5xxRate` | 5xx なら 1、そうでなければ 0（平均が率） |
| `RetentionAbandonedGames` | 保持削除（retention）で、再試行をやめたゲームの数（定期タスクの結果） |
| `StreamMismatchGames` | 整合の検査（verify）で、不一致のあるゲームの数（定期タスクの結果） |

操作名（`Operation`）は、契約の `operationId`（`getGameState`・`getReady` など）。資格・表示名・相関 ID は含めない。

## アラーム

閾値の表は、コードの `Alarms`（`apps/beer-game-scala/application/.../Alarms.scala`）。Terraform（`infra/modules/observability/alarms.tf`）は、`AlarmTerraformSpec` が表との一致を検査する。閾値は仮置き（未計測）。

| アラーム | 条件 | 指標が出ているか |
| :--- | :--- | :--- |
| `main-operation-stall`（重大） | 研修中に、主要な操作の成功が 60 秒で 0 | **未出力** |
| `synthetic-failure`（重大） | 合成監視（1 分ごと）が連続 2 期間失敗 | 合成監視（CloudWatch Synthetics）が出す |
| `append-conflict-rate-warning`（警告）・`-critical`（重大） | 追記の競合率が 5% 以上（2 期間）・20% 以上（3 期間） | **未出力** |
| `jvm-heap-critical`（重大） | ヒープ使用率 85% 以上が 10 分 | **未出力** |
| `http-5xx-rate-*`・`api-latency-p95-*` | 5xx の率・応答の p95 | 出ている |
| `retention-abandoned`・`stream-mismatch` と、それぞれの心拍 | 定期タスクの結果と、動いていること | 出ている |

**欠測を異常と扱うアラーム（`main-operation-stall` など）は、指標が出ないと誤報になる。** 適用前に、指標を出すか、アラームを無効にする。

## 訓練

アラームの評価は純粋関数で、模擬の時計と故障を模擬した入力で「訓練」できる（`AlarmsSpec`・受け入れの `metrics-and-alarms.feature`）。AWS 上の訓練・通知（SNS）の配送は未実施。
