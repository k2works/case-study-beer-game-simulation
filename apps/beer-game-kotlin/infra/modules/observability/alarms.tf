# アラーム（B13。設計書 operation.md「監視項目と閾値」）。
# 閾値・期間・評価の回数は、application の AlarmCatalog と同じ値でなければならない。
# 食い違いは、app の AlarmCatalogSpec が、このファイルを読んで検出する（キーの書式を変えるときは、その試験も直す）。
# 「提案」の閾値は、実装後の実測で見直す。適用はしない（定義だけ。適用は別ゲート）。

locals {
  # アプリのメトリクス（EMF。adapter-http）。ディメンションは Environment だけの系列を使う
  app = {
    namespace          = var.namespace
    dimensions         = { Environment = var.environment }
    statistic          = "Maximum"
    extended_statistic = ""
    missing            = "notBreaching"
    training_only      = false
  }

  # 合成監視（CloudWatch Synthetics）のメトリクス
  synthetics = merge(local.app, {
    namespace  = "CloudWatchSynthetics"
    dimensions = { CanaryName = local.canary_name }
  })

  alarms = {
    # 研修中に、主要な操作が 1 分間（10 秒 x 5 期間）成功しない。欠測も超過とみなす。研修中だけ通知する
    "main-operation-stall" = merge(local.app, {
      metric_name        = "MainOperationSuccess"
      statistic          = "Sum"
      comparison         = "LessThanThreshold"
      threshold          = 1
      period             = 10
      evaluation_periods = 5
      missing            = "breaching"
      severity           = "critical"
      training_only      = true
      description        = "研修中に、主要な操作が 1 分間成功していない（作成・参加・保存・確定）"
    })

    "synthetic-failure" = merge(local.synthetics, {
      metric_name        = "SuccessPercent"
      statistic          = "Average"
      comparison         = "LessThanThreshold"
      threshold          = 100
      period             = 60
      evaluation_periods = 1
      missing            = "breaching"
      severity           = "critical"
      description        = "合成監視（1 分ごとの /api/v1/ready）が失敗した。最悪 2 分で検知する"
    })

    "http-5xx-rate-warning" = merge(local.app, {
      metric_name        = "ServerError"
      statistic          = "Average"
      comparison         = "GreaterThanThreshold"
      threshold          = 0.01
      period             = 300
      evaluation_periods = 1
      severity           = "warning"
      description        = "5xx の割合が 1% 超（5 分）"
    })

    "http-5xx-rate-critical" = merge(local.app, {
      metric_name        = "ServerError"
      statistic          = "Average"
      comparison         = "GreaterThanThreshold"
      threshold          = 0.05
      period             = 60
      evaluation_periods = 1
      severity           = "critical"
      description        = "5xx の割合が 5% 超（1 分）"
    })

    "api-latency-p95-warning" = merge(local.app, {
      metric_name        = "RequestDurationMillis"
      extended_statistic = "p95"
      comparison         = "GreaterThanThreshold"
      threshold          = 800
      period             = 300
      evaluation_periods = 1
      severity           = "warning"
      description        = "API の応答の p95 が 800 ミリ秒超（5 分）"
    })

    "api-latency-p95-critical" = merge(local.app, {
      metric_name        = "RequestDurationMillis"
      extended_statistic = "p95"
      comparison         = "GreaterThanThreshold"
      threshold          = 1000
      period             = 300
      evaluation_periods = 1
      severity           = "critical"
      description        = "API の応答の p95 が 1 秒超（5 分）"
    })

    "append-conflict-rate-warning" = merge(local.app, {
      metric_name        = "ConcurrencyConflict"
      statistic          = "Average"
      comparison         = "GreaterThanThreshold"
      threshold          = 0.05
      period             = 300
      evaluation_periods = 1
      severity           = "warning"
      description        = "追記の競合率が 5% 超（5 分。提案）"
    })

    "append-conflict-rate-critical" = merge(local.app, {
      metric_name        = "ConcurrencyConflict"
      statistic          = "Average"
      comparison         = "GreaterThanThreshold"
      threshold          = 0.2
      period             = 300
      evaluation_periods = 1
      severity           = "critical"
      description        = "追記の競合率が 20% 超（5 分。提案）"
    })

    "retry-exhausted-warning" = merge(local.app, {
      metric_name        = "RetryExhausted"
      statistic          = "Sum"
      comparison         = "GreaterThanThreshold"
      threshold          = 0
      period             = 300
      evaluation_periods = 1
      severity           = "warning"
      description        = "再試行の上限超過が 1 件以上（5 分）"
    })

    "retry-exhausted-critical" = merge(local.app, {
      metric_name        = "RetryExhausted"
      statistic          = "Sum"
      comparison         = "GreaterThanThreshold"
      threshold          = 4
      period             = 300
      evaluation_periods = 1
      severity           = "critical"
      description        = "再試行の上限超過が 5 件以上（5 分。提案）"
    })

    # 日次の検査（verify-projections）の結果。検査のタスクの定義とスケジュールは B14
    "projection-mismatch" = merge(local.app, {
      metric_name        = "ProjectionMismatchGames"
      comparison         = "GreaterThanThreshold"
      threshold          = 0
      period             = 86400
      evaluation_periods = 1
      severity           = "critical"
      description        = "投影が、イベントから作り直した結果と一致しないゲームがある"
    })

    "projection-lag" = merge(local.app, {
      metric_name        = "ProjectionLagGames"
      comparison         = "GreaterThanThreshold"
      threshold          = 0
      period             = 86400
      evaluation_periods = 1
      severity           = "critical"
      description        = "投影の進んだ版が、イベントの最後の版より遅れているゲームがある"
    })

    # 保持削除（retention）の結果。タスクの定義とスケジュールは B14
    "retention-abandoned" = merge(local.app, {
      metric_name        = "RetentionAbandonedGames"
      comparison         = "GreaterThanThreshold"
      threshold          = 0
      period             = 300
      evaluation_periods = 1
      severity           = "critical"
      description        = "削除の再試行の上限に達して、削除をやめたゲームがある（運営者への連絡が要る）"
    })

    # 心拍（B14）: 定期タスクが止まると、上のメトリクスが出ない。値は 0 以上なので「0 未満」は成り立たず、欠測だけが発報の理由
    "projection-verify-heartbeat" = merge(local.app, {
      metric_name        = "ProjectionMismatchGames"
      comparison         = "LessThanThreshold"
      threshold          = 0
      period             = 86400
      evaluation_periods = 1
      missing            = "breaching"
      severity           = "warning"
      description        = "日次の投影の整合の検査（verify-projections）が 1 日動いていない（結果のメトリクスが無い）"
    })

    "retention-heartbeat" = merge(local.app, {
      metric_name        = "RetentionAbandonedGames"
      comparison         = "LessThanThreshold"
      threshold          = 0
      period             = 3600
      evaluation_periods = 1
      missing            = "breaching"
      severity           = "warning"
      description        = "保持削除の掃引（retention。5 分ごと）が 1 時間動いていない（結果のメトリクスが無い）"
    })

    "jvm-heap-warning" = merge(local.app, {
      metric_name        = "JvmHeapUsedPercent"
      comparison         = "GreaterThanThreshold"
      threshold          = 70
      period             = 60
      evaluation_periods = 10
      severity           = "warning"
      description        = "ヒープの使用率が 70% 超（10 分）"
    })

    "jvm-heap-critical" = merge(local.app, {
      metric_name        = "JvmHeapUsedPercent"
      comparison         = "GreaterThanThreshold"
      threshold          = 85
      period             = 60
      evaluation_periods = 10
      severity           = "critical"
      description        = "ヒープの使用率が 85% 超（10 分）"
    })

    "jvm-gc-pause-warning" = merge(local.app, {
      metric_name        = "JvmGcPauseMillis"
      comparison         = "GreaterThanThreshold"
      threshold          = 200
      period             = 60
      evaluation_periods = 5
      severity           = "warning"
      description        = "GC の 1 回あたりの停止が 200 ミリ秒超（5 分。提案。p99 でなく区間の平均）"
    })

    "jvm-gc-pause-critical" = merge(local.app, {
      metric_name        = "JvmGcPauseMillis"
      comparison         = "GreaterThanThreshold"
      threshold          = 500
      period             = 60
      evaluation_periods = 5
      severity           = "critical"
      description        = "GC の 1 回あたりの停止が 500 ミリ秒超（5 分。提案）"
    })

    "db-pool-utilization-warning" = merge(local.app, {
      metric_name        = "DbPoolUtilizationPercent"
      comparison         = "GreaterThanThreshold"
      threshold          = 70
      period             = 60
      evaluation_periods = 10
      severity           = "warning"
      description        = "接続プールの使用率が 70% 超（10 分）"
    })

    "db-pool-utilization-critical" = merge(local.app, {
      metric_name        = "DbPoolUtilizationPercent"
      comparison         = "GreaterThanThreshold"
      threshold          = 80
      period             = 60
      evaluation_periods = 10
      severity           = "critical"
      description        = "接続プールの使用率が 80% 超（10 分）"
    })
  }
}

resource "aws_cloudwatch_metric_alarm" "app" {
  for_each = local.alarms

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric_name
  dimensions          = each.value.dimensions
  statistic           = each.value.extended_statistic == "" ? each.value.statistic : null
  extended_statistic  = each.value.extended_statistic == "" ? null : each.value.extended_statistic
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.evaluation_periods
  treat_missing_data  = each.value.missing

  actions_enabled = each.value.training_only ? var.training_alarms_enabled : true
  alarm_actions   = [each.value.severity == "critical" ? aws_sns_topic.critical.arn : aws_sns_topic.warning.arn]
  ok_actions      = [each.value.severity == "critical" ? aws_sns_topic.critical.arn : aws_sns_topic.warning.arn]
}

# インフラ側のアラーム（アプリのメトリクスを待たずに、停止を知る）
#
# ブルー/グリーン（B14）では、ECS が 2 つの対象グループを交互に使う。使っていない側の正常数は常に 0 なので、
# 片側だけを見ると、切り替えのたびに誤報（または見逃し）になる。2 つの対象グループの正常数の最大が 1 未満のとき発報する。
locals {
  target_groups = compact([var.target_group_arn_suffix, var.alternate_target_group_arn_suffix])
}

resource "aws_cloudwatch_metric_alarm" "no_healthy_targets" {
  alarm_name          = "${var.name}-no-healthy-targets"
  alarm_description   = "負荷分散の対象に、正常なタスクが無い（1 分。ブルー/グリーンの 2 つの対象グループの最大）"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.critical.arn]
  ok_actions          = [aws_sns_topic.critical.arn]

  metric_query {
    id          = "healthy"
    expression  = "MAX([${join(",", [for i, tg in local.target_groups : "tg${i}"])}])"
    label       = "正常なタスクの数（最大）"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = local.target_groups
    content {
      id = "tg${metric_query.key}"
      metric {
        namespace   = "AWS/ApplicationELB"
        metric_name = "HealthyHostCount"
        dimensions  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = metric_query.value }
        period      = 60
        stat        = "Minimum"
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "task_cpu" {
  alarm_name          = "${var.name}-task-cpu-critical"
  alarm_description   = "ECS タスクの CPU が 80% 超（10 分）"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = var.service_name }
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  period              = 60
  evaluation_periods  = 10
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.critical.arn]
  ok_actions          = [aws_sns_topic.critical.arn]
}
