# 観測の完成（docs/development/beer-game2/bolt_11_plan.md）: 通知、アラーム、合成監視、ダッシュボード。
# メトリクスはアプリが CloudWatch の EMF で出す（名前空間 BeerGame2、次元 Environment）
locals {
  namespace = "BeerGame2"
  dims      = { Environment = var.name }
}

data "aws_region" "current" {}

resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# API の p95 が 1 秒超（5 分）
resource "aws_cloudwatch_metric_alarm" "latency_p95" {
  alarm_name          = "${var.name}-api-latency-p95"
  namespace           = local.namespace
  metric_name         = "Latency"
  dimensions          = local.dims
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.latency_p95_threshold_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# 5xx（5 分）
resource "aws_cloudwatch_metric_alarm" "server_errors" {
  alarm_name          = "${var.name}-server-errors"
  namespace           = local.namespace
  metric_name         = "ServerErrors"
  dimensions          = local.dims
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.server_errors_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# 週結果の重複・不変条件の違反（1 件で発報。AC6.1.6）
resource "aws_cloudwatch_metric_alarm" "invariant_violations" {
  alarm_name          = "${var.name}-invariant-violations"
  namespace           = local.namespace
  metric_name         = "InvariantViolations"
  dimensions          = local.dims
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# 削除の恒久的な失敗（1 件で発報。5 分以内に通知）
resource "aws_cloudwatch_metric_alarm" "retention_permanent_failures" {
  alarm_name          = "${var.name}-retention-permanent-failures"
  namespace           = local.namespace
  metric_name         = "RetentionPermanentFailures"
  dimensions          = local.dims
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# 合成監視（1 分ごと）。成果物の置き場と、実行のロール
resource "aws_s3_bucket" "canary" {
  bucket_prefix = "${var.name}-canary-"
  force_destroy = true
}

data "aws_iam_policy_document" "canary_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "canary" {
  name               = "${var.name}-canary"
  assume_role_policy = data.aws_iam_policy_document.canary_assume.json
}

resource "aws_iam_role_policy" "canary" {
  name = "canary"
  role = aws_iam_role.canary.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetBucketLocation"]
        Resource = [aws_s3_bucket.canary.arn, "${aws_s3_bucket.canary.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
      {
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "CloudWatchSynthetics" } }
      },
    ]
  })
}

data "archive_file" "canary" {
  type        = "zip"
  source_file = "${path.module}/canary/index.js"
  output_path = "${path.module}/.build/canary.zip"
}

resource "aws_synthetics_canary" "ready" {
  name                 = substr(replace("${var.name}-ready", "_", "-"), 0, 21)
  artifact_s3_location = "s3://${aws_s3_bucket.canary.bucket}/"
  execution_role_arn   = aws_iam_role.canary.arn
  handler              = "index.handler"
  zip_file             = data.archive_file.canary.output_path
  runtime_version      = "syn-nodejs-puppeteer-9.1"
  start_canary         = true

  schedule {
    expression = "rate(1 minute)"
  }

  run_config {
    timeout_in_seconds = 30
    environment_variables = {
      TARGET_URL = var.ready_url
    }
  }
}

# 研修中の停止: 合成監視が 1 回（1 分）失敗したら発報する（AC6.1.5。研修中の停止を 1 分以内に検知）
resource "aws_cloudwatch_metric_alarm" "canary" {
  alarm_name          = "${var.name}-ready-canary"
  namespace           = "CloudWatchSynthetics"
  metric_name         = "SuccessPercent"
  dimensions          = { CanaryName = aws_synthetics_canary.ready.name }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 1
  threshold           = 100
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ダッシュボード: 量・応答時間・エラー、確定と競合、SSE、削除（NF-O5）
resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = [
      for i, w in [
        { title = "リクエスト（件）", metrics = [[local.namespace, "Requests", "Environment", var.name, { stat = "Sum" }]] },
        { title = "応答時間 p95（ms）", metrics = [[local.namespace, "Latency", "Environment", var.name, { stat = "p95" }]] },
        { title = "5xx と不変条件の違反（件）", metrics = [[local.namespace, "ServerErrors", "Environment", var.name, { stat = "Sum" }], [local.namespace, "InvariantViolations", "Environment", var.name, { stat = "Sum" }]] },
        { title = "週の確定と競合（件）", metrics = [[local.namespace, "WeekCommitted", "Environment", var.name, { stat = "Sum" }], [local.namespace, "Conflicts", "Environment", var.name, { stat = "Sum" }]] },
        { title = "SSE の接続数（タスクの最大）", metrics = [[local.namespace, "SseConnections", "Environment", var.name, { stat = "Maximum" }]] },
        { title = "保持の削除（件）", metrics = [[local.namespace, "RetentionDeleted", "Environment", var.name, { stat = "Sum" }], [local.namespace, "RetentionFailed", "Environment", var.name, { stat = "Sum" }], [local.namespace, "RetentionPermanentFailures", "Environment", var.name, { stat = "Sum" }]] },
        ] : {
        type   = "metric"
        x      = (i % 2) * 12
        y      = floor(i / 2) * 6
        width  = 12
        height = 6
        properties = {
          title   = w.title
          metrics = w.metrics
          region  = data.aws_region.current.name
          period  = 60
          view    = "timeSeries"
        }
      }
    ]
  })
}
