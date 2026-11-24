---
type: Plan
title: "Bolt 14 計画 - 観測の完成（Rust 版）"
description: "beer-game-rust の Bolt 14 のステップ計画。EMF のメトリクス出力、アラームの閾値の表（AlarmCatalog）と Terraform の一致検査、アラームの訓練（模擬の時計）、投影の整合・保持のメトリクスの出力、Rust の実行環境の観測（RSS・tokio のタスク・panic）。metrics-and-alarms.feature の許可。人の承認待ちの草案。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-23T00:00:00Z }
---

# Bolt 14 計画 - 観測の完成（Rust 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B14（[リリース計画](./release_plan.md)）。Unit U5 |
| 所要（計画） | 2 稼働日（仮定。メトリクスの種類が多いため、超える可能性がある） |
| ゲート密度 | 標準（リリース計画の表）。ただし**新規依存の承認**と**アラームの閾値の判断**は人が行う |
| 状態 | **2026-11-23 にユーザーが「承認」（計画と判断項目 1〜9 を、書かれたとおりに。新規依存なし、閾値は Terraform の既存値のまま、JVM のシナリオは対象外、panic の方針は変えない）。着手済み** |

### ゴール

研修中の停止を 1 分以内に検知できる。そのために、アプリが CloudWatch の EMF（JSON 行を標準出力へ）でメトリクスを出し、アラームの閾値の表がコードと Terraform で一致し、模擬の時計と故障でアラームを訓練できる。投影の整合の検査・保持の削除の結果もメトリクスになる。Rust 固有の実行環境（RSS、tokio のタスク、panic、接続プール）も観測できる。**AWS には適用しない**（定義まで。B15 以降）。

### 確認したい仮説（リリース計画より）

研修中の停止を 1 分以内に検知できるか。

## 現状の確認（読み取りで確かめた事実）

- **アプリはメトリクスを出していない**（`metrics`・EMF に当たるコードは無い）。出ているのは、リクエストの構造化ログ（`target: "http"`、`elapsed_ms`、`status`、`correlation_id`）だけ。
- **Terraform は既にある**: `infra/modules/observability`（`alarms.tf` 291 行・`main.tf` のダッシュボード・`canary/ready.js`）。アラームの `metric_name` は、`MainOperationSuccess`・`SuccessPercent`（合成監視）・`ServerError`・`RequestDurationMillis`・`ConcurrencyConflict`・`RetryExhausted`・`ProjectionMismatchGames`・`ProjectionLagGames`・`RetentionAbandonedGames`・`DbPoolUtilizationPercent`・`HealthyHostCount`・`CPUUtilization`。**アプリがこれらの名前で出して初めてつながる**。
- **Kotlin 版の対応物**: `AlarmCatalog.kt`（閾値の表。Terraform と同じ値で、`AlarmCatalogSpec` が食い違いを検出）、`Metrics.kt`、`Alarms.kt`（評価）、`EmfMetricSink.kt`。共有する `features/operations/metrics-and-alarms.feature`（11 シナリオ、`@api`）は、許可リストに無い（B13 終了時の未対応 15 件に含まれる）。
- **B13 から引き継ぐもの**: `verify-projections`・`retention` の結果（`checked`・`inconsistent`・`skipped`・`failed`、`abandoned`）は、ログに出ているがメトリクスではない。`lock_timeout` の超過（`RetryExhausted`）の件数も未計測。

## 対象の受入条件

| 対象 | 内容 | feature |
| :--- | :--- | :--- |
| AC6.1.3 | 応答時間・要求数・エラー率・追記の競合率などのメトリクス（EMF）。秘密・表示名を含まない | `operations/metrics-and-alarms.feature` |
| AC6.1.5 | 研修中の停止を 1 分以内に検知（`main-operation-stall`）。合成監視の失敗を 2 分以内 | 同上 |
| AC6.1.6 | 投影の不一致・遅れのメトリクスと、重大のアラーム | 同上 |
| NF-O3・O5・O12・O4 | メトリクス・ダッシュボードの項目（RSS・タスク数・接続プールの待ち・panic 件数）、アラームの対象 | メトリクスの契約テスト、ダッシュボード定義の検査 |

## 着手前に人の判断が要る項目

| # | 項目 | 案 |
| :--- | :--- | :--- |
| 1 | **新規依存** | 原則なし。EMF は `serde_json` で JSON 行を組み立てて標準出力へ（Kotlin 版と同じ方式）。**RSS・tokio のタスク数の取得**に、`tokio` の `RuntimeMetrics`（安定版で取れる範囲）と、RSS は `/proc/self/statm`（Linux）を自前で読む案。**`sysinfo` などのクレートは入れない**（入れるなら版を確認して人が承認）。macOS の手元では RSS を出さない（`None`）扱い |
| 2 | **メトリクスの出し方** | 型付きの `MetricSink` ポート（`application`）と、EMF 実装（`adapter-http` か新しい小さなモジュール）。ドメインには持ち込まない。秘密・表示名は、**メトリクスの型に載せない**（ログの `LogRecord` の考え方と同じ。型で除外） |
| 3 | **アラームの閾値** | Terraform の既存の値（Kotlin 版から引き継いだ提案値）を**そのまま使い、変えない**。`AlarmCatalog` をコードに置き、Terraform と一致する検査を足す。**Rust 固有の閾値（RSS・panic・タスク数）は提案値で、実測後に見直す**（人が確認） |
| 4 | **メモリのアラーム** | リリース計画どおり「実測後に追加」。**B14 では閾値を決めず、メトリクス（RSS）を出すところまで** |
| 5 | **JVM 関連の項目** | Kotlin 版の `jvm-heap-critical` に当たる共有 feature のシナリオがある（「JVM のヒープの使用率…」）。**Rust 版には JVM が無い**。共有する feature は変更しないため、そのシナリオは**許可リストの対象外**とする（理由を許可リストに書く）。Rust 版のメモリ（RSS）のアラームは、実測後の別の判断 |
| 6 | **panic の扱い** | 設計の未決（記録して継続するか、落とすか）。B14 では **panic フックで件数をメトリクスに出し、ログに残す**（継続か終了かは変えない。現状の挙動のまま）。方針の決定は人（B16 まで） |
| 7 | **DB・契約・画面の変更** | なし（DDL・`openapi.yaml`・Web は触らない） |
| 8 | **ダッシュボード・合成監視** | 既存の Terraform の定義を、メトリクス名と一致させる検査まで。**適用しない**。NF-O5 の項目（RSS・タスク数・接続プールの待ち・panic・`idle in transaction`）が定義に含まれることを、定義ファイルの検査で確かめる（含まれていなければ足す） |
| 9 | **NF-P18 への対応（B13 から）** | **B14 の範囲に含めない**。再構築の所要時間はメトリクス（`ProjectionRebuildMillis`）として出すが、最適化は別の判断（B13 報告の判断項目 1） |

## ステップ計画（各ステップの終わりで人のゲート）

1. **読み取り**: Kotlin の `Metrics.kt`・`Alarms.kt`・`AlarmCatalog.kt`・`EmfMetricSink.kt` と `MetricsAndAlarmsSteps` に当たる受入のステップ、Rust の `infra/modules/observability` を読み、差を一覧にする（**特に、Terraform の `metric_name` とアプリが出す名前の対応表**）。
2. **判断項目の承認（人のゲート）**: 上の 1〜6（特に依存の有無と JVM シナリオの扱い）。
3. **Red（先に書く）**: `metrics-and-alarms.feature` を許可リストへ（JVM のシナリオを除く 10 件）。受入のステップは未定義で失敗する。メトリクスの契約テスト（EMF の形式、名前、秘密を含まないこと）を書いて失敗を確かめる。
4. **メトリクスの出力**: `MetricSink` ポートと EMF 実装。リクエストの応答時間・要求数・5xx、主要な操作の成功（`MainOperationSuccess`）、追記の競合・再試行の上限超過、接続プールの使用率。HTTP の層（既存のリクエストログの箇所）で記録する。
5. **アラームの閾値の表と評価**: `AlarmCatalog`（`application`）と、模擬の時計・入力でアラームを評価する関数。Terraform の `alarms.tf` との一致を検査する（食い違いで失敗）。受入の 10 シナリオ（停止 60 秒以内、40 秒までは発報しない、研修外は発報しない、合成監視 2 分、追記の競合率の急増）を通す。
6. **整合・保持のメトリクス**: `verify-projections` が `ProjectionMismatchGames`・`ProjectionLagGames` を、`retention` が `RetentionAbandonedGames` を出す（B13・B12 の結果から）。再構築の所要時間も出す。受入（不一致 1 件・0 件のシナリオ）を通す。
7. **Rust の実行環境の観測**: RSS（Linux のみ）、tokio のタスク数、panic の件数を出す。NF-O12。ダッシュボード定義の検査。
8. **品質ゲート・記録**: `just backend-check`、`just acceptance`、`just ui-acceptance`（**Node 26 で実行**）。`terraform validate`（手元で可能な範囲。適用しない）。`bolt_14_report.md`、`index.md`、`mkdocs.yml`、`docs/log.md`、`okf:check`。
9. **コミット・push・CI**（区切りごと）。

## 範囲外

AWS への適用、本番の定義（B15）、メモリのアラームの閾値（実測後）、panic の継続・終了の方針、NF-P18 の最適化、必須ジョブ・hook の導入（守りの導入計画）。

## リスク

| # | リスク | 対応 |
| :--- | :--- | :--- |
| R1 | メトリクスの名前が Terraform とずれ、アラームが永久に欠測になる | Step 1 の対応表と、Step 5 の一致検査（食い違いで失敗） |
| R2 | メトリクスに秘密・表示名が混ざる | 型で載せない。契約テストで、参加者の表示名を入れたゲームの出力を検査（受入の 1 本目） |
| R3 | 標準出力への出力が、構造化ログと混ざって解析できない | EMF は `_aws` を持つ行として、別の `target` と形式で区別する。契約テストで、行ごとに JSON として読めることを確かめる |
| R4 | 模擬の時計の訓練が、実際の CloudWatch の評価（欠測の扱い、期間の切り方）と食い違う | **AWS 上では未確認**と明記する。Terraform の `treat_missing_data` と閾値の表の一致までを検査する |
| R5 | RSS・タスク数の取得が Linux 以外で動かず、手元の試験が通らない | 取得できない環境では出さない（`None`）。取得の関数は、環境の差を吸収して単体でテストする |

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-23 | 初版作成（草案。人の承認待ち） | claude-code |
