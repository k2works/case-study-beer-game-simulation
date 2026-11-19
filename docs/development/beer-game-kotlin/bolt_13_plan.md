---
type: Plan
title: "Bolt 13 計画 - 観測の完成（Kotlin 版）"
description: "beer-game-kotlin の Bolt 13（Unit U5 の 3 つ目）のステップ計画。メトリクス（EMF）、アラームの閾値の評価と訓練、Terraform の定義（アラーム・ダッシュボード・合成監視・SNS。適用しない）、運用手順書。/goal U5 に基づく自律実行の記録。ゲートは未承認。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-17T22:00:00Z }
---

# Bolt 13 計画 - 観測の完成

> **承認の状態について**: 本書は、ユーザーの `/goal U5`（Unit U5 を完了する）に基づいて、AI が計画を書いたうえで実装した記録です。**判断項目とゲートの個別の承認は、受けていません（すべて未承認）。** 実装の結果は [bolt_13_report](./bolt_13_report.md)。

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B13（[リリース計画](./release_plan.md)）。U5 の 3 つ目 |
| 対象 | US6.1（AC6.1.3、AC6.1.5、AC6.1.6。AC6.1.1・AC6.1.2・AC6.1.4 は B1 で実装済み）、NF-O3、NF-O4、NF-O12 |
| アプローチ | インサイドアウト。日本語 Gherkin（`@api`）と単体テストを先に書いて Red → 純粋な型と関数（メトリクス、EMF、アラームの評価）→ 収集点の配線（HTTP、コマンドの再試行、保守の起動モード、JVM）→ Terraform の定義 → 手順書 |
| 仮説 | 研修中の停止を 1 分以内に検知できる。ただし「検知」は、アラームが状態を変えるまでで、SNS の配送の時間は含まない |
| 適用 | **AWS へは適用しない**。Terraform は定義まで。適用は範囲外の別ゲート（B14 以降） |

## 判断項目（AI の提案どおりに進める。未承認）

| # | 項目 | 案 |
| :-: | :--- | :--- |
| 1 | スキーマ・契約・画面の変更 | **なし**（DB のマイグレーション、`openapi.yaml`、Web は触らない） |
| 2 | メトリクスの出力 | BD9 のとおり、EMF の JSON 行を、自前の小さな関数で標準出力へ。名前空間は `BeerGame/Kotlin`。ディメンションは `Environment` と、操作のあるものは `Environment` + `Operation`。**ゲーム ID・表示名・資格は、型（`MetricSample`）に持たない**（NF-S14） |
| 3 | 収集する指標（この Bolt で実装） | HTTP: 応答時間、要求数、5xx（0/1。平均が率）、主要な操作の成功。コマンド: 追記の競合（試行ごとに 0/1）、再試行の上限超過。保守: 投影の不一致・遅れ・検査できず（`verify-projections`）、削除の放棄（`retention`）。JVM: ヒープの使用率、GC の 1 回あたりの停止時間、接続プールの使用率（60 秒ごと） |
| 4 | 収集しない指標（設計にあるが、この Bolt では未実装。報告書と手順書に明記） | SSE の接続数・通知の遅延（API に SSE がまだ無い）、再生したイベント数と時間・投影の更新時間（永続化の内部の計測。計測点を足すには永続化の層の変更が要る）、イベントの読み込み失敗（現在は 500 の一部として現れる）、削除の期限超過の経過時間（問い合わせのジョブ）、`DecisionConflict` の件数（API の結果コード `session.decision_conflict` のログで代用） |
| 5 | アラームの評価 | 純粋関数 `evaluateAlarms`（CloudWatch のアラームと同じ意味: 期間、評価の回数、超過の回数、欠測の扱い、統計）。閾値の表は `AlarmCatalog`（設計書の「監視項目と閾値」）。Terraform の定義と**同じ値**であることを、`AlarmCatalogSpec` が `.tf` を読んで検査する |
| 6 | 訓練 | `detectionDelay`（模擬の時計で、評価を 10 秒ごとに進め、障害の時刻から最初に発報するまでの時間を返す）。実際の待機はしない。故障の模擬: 停止、5xx の急増、競合率の急増、投影の遅れ・不一致、削除の放棄、ヒープの逼迫 |
| 7 | 「1 分間成功しない」の定義 | 主要な操作（`createGame`・`joinGame`・`saveDecision`・`commitWeek`）の成功数が、10 秒の期間 5 回続けて 0（欠測は超過とみなす）。研修中だけ有効（`training_alarms_enabled`。研修のない時間は、操作が無くて当然なので、通知しない）。ほかに、合成監視（1 分ごとの `/api/v1/ready`）の失敗でも発報する（こちらは最悪 2 分。訓練で実測し、報告書に書く） |
| 8 | 合成監視 | CloudWatch Synthetics のカナリア（`rate(1 minute)`、`/api/v1/ready` の取得）。**データを書く業務の操作は呼ばない**（本番にゲームが溜まるため）。業務の操作の監視は 7 のアプリのメトリクスが担う。カナリアのランタイムの版とスクリプトは、AWS 上で未確認 |
| 9 | 通知（SNS） | 重大（Critical）と警告（Warning）で 2 つのトピック。購読（メール）は変数で渡す。通知の経路は B11 の「放棄の通知」と B12 の日次検査のメトリクスから、同じアラームに合流する。ECS の定期タスク（保持・検査）の定義とスケジュールは **B14**（`infra/modules/ecs` には、まだ無い） |
| 10 | Terraform | 新しいモジュール `infra/modules/observability`（アラーム、ダッシュボード、SNS、カナリア）。ステージングと本番の `main.tf` から呼ぶ。`terraform validate` が使えるかは実行して確かめる（手元は Terraform 1.5.7。env の `required_version` は 1.17 以上のため、env の validate はできない見込み） |
| 11 | 起動モードの配線 | `retention`・`verify-projections` は終了時に、メトリクスを標準出力へ 1 回書く。`rebuild-projections` は書かない |

## ステップ

1. 計画書（本書）と受入シナリオ（`features/operations/metrics-and-alarms.feature`）、単体テストを書き、Red にする
2. アプリケーション: `MetricSample`・`MetricSink`、アラームの型と `evaluateAlarms`、`AlarmCatalog`、`detectionDelay`、保守・保持・JVM のメトリクスを作る純粋関数
3. アダプター: EMF の書き出し（`EmfFormat`）、HTTP の収集点（`Observability`）、コマンドの再試行の収集点（`withAppendRetry`）
4. 起動: 標準出力のシンク、JVM の定期サンプラー、保守モードへの配線
5. Terraform（`infra/modules/observability`、環境の呼び出し、ALB のモジュールの出力）。`terraform fmt`・可能なら `validate`
6. 運用手順書（`docs/operation/beer-game-kotlin/observability.md`）と設計書（`operation.md`）の更新
7. 全検査、報告書、`release_plan.md` の進捗表

## 更新履歴

| 日付 | 内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-17 | `/goal U5` に基づく自律実行のため、計画を書いて実装した。**判断項目・ゲートは未承認** | claude-code/claude-sonnet-5-5 |
| 2026-11-19 | ユーザーが、判断項目とゲートを承認した（指示: 「Boltゲートの承認」。範囲の選択: U3（B7・B8）・U4（B4・B9・B10）・U5（B11〜B14）・U6（B15）。内容の選択: 「判断項目とゲートのみ」）。判断項目は AI の提案どおりの決定として承認された。**この承認に含まれない**: デモ項目の人の実操作、コードの全行理解、AWS への適用（CloudWatch・SNS・Synthetics。通知の経路・オンコールの体制を含む。別の承認ゲート） | user（記録: claude-code/claude-sonnet-5-5） |
