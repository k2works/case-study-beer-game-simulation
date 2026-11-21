# 観測の定義（B13）: 通知（SNS）、合成監視（CloudWatch Synthetics）、ダッシュボード。アラームは alarms.tf。
# 適用はしない（定義だけ）。AWS 上の動作は未確認。

locals {
  canary_name = substr("${var.name}-ready", 0, 21) # Synthetics のカナリア名は 21 文字まで
}

# ---- 通知（SNS）。重大と警告で分ける。メールの購読は、適用後に宛先が確認する ----

resource "aws_sns_topic" "critical" {
  name = "${var.name}-alarm-critical"
}

resource "aws_sns_topic" "warning" {
  name = "${var.name}-alarm-warning"
}

resource "aws_sns_topic_subscription" "critical_email" {
  for_each  = toset(var.critical_emails)
  topic_arn = aws_sns_topic.critical.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_sns_topic_subscription" "warning_email" {
  for_each  = toset(var.warning_emails)
  topic_arn = aws_sns_topic.warning.arn
  protocol  = "email"
  endpoint  = each.value
}

data "aws_caller_identity" "current" {}

# CloudWatch のアラームだけが、このアカウントのアラームから発行できる
data "aws_iam_policy_document" "alarm_publish" {
  for_each = { critical = aws_sns_topic.critical.arn, warning = aws_sns_topic.warning.arn }

  statement {
    actions   = ["sns:Publish"]
    resources = [each.value]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "critical" {
  arn    = aws_sns_topic.critical.arn
  policy = data.aws_iam_policy_document.alarm_publish["critical"].json
}

resource "aws_sns_topic_policy" "warning" {
  arn    = aws_sns_topic.warning.arn
  policy = data.aws_iam_policy_document.alarm_publish["warning"].json
}

# ---- 合成監視。1 分ごとに /api/v1/ready を取得する。業務の操作（ゲームの作成など）は呼ばない（本番にデータが溜まるため） ----

data "archive_file" "canary" {
  type        = "zip"
  output_path = "${path.module}/.canary.zip"

  source {
    content  = file("${path.module}/canary/ready.js")
    filename = "nodejs/node_modules/ready.js"
  }
}

resource "aws_s3_bucket" "canary" {
  bucket_prefix = "${substr(var.name, 0, 30)}-canary-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "canary" {
  bucket                  = aws_s3_bucket.canary.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "canary" {
  bucket = aws_s3_bucket.canary.id

  rule {
    id     = "expire-artifacts"
    status = "Enabled"
    filter {}
    expiration {
      days = 14
    }
  }
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

data "aws_iam_policy_document" "canary" {
  statement {
    actions   = ["s3:PutObject", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.canary.arn, "${aws_s3_bucket.canary.arn}/*"]
  }
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/cwsyn-*"]
  }
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }
}

resource "aws_iam_role_policy" "canary" {
  name   = "canary"
  role   = aws_iam_role.canary.id
  policy = data.aws_iam_policy_document.canary.json
}

resource "aws_synthetics_canary" "ready" {
  name                 = local.canary_name
  artifact_s3_location = "s3://${aws_s3_bucket.canary.id}/"
  execution_role_arn   = aws_iam_role.canary.arn
  handler              = "ready.handler"
  zip_file             = data.archive_file.canary.output_path
  runtime_version      = var.canary_runtime_version
  start_canary         = true

  schedule {
    expression = "rate(1 minute)"
  }

  run_config {
    timeout_in_seconds = 30
    environment_variables = {
      TARGET_HOST = var.public_domain
    }
  }
}

# ---- ダッシュボード ----

locals {
  widgets = [
    {
      type = "metric", x = 0, y = 0, width = 12, height = 6
      properties = {
        title  = "応答時間（p95）と要求数"
        region = var.region
        view   = "timeSeries"
        stat   = "p95"
        period = 60
        metrics = [
          [var.namespace, "RequestDurationMillis", "Environment", var.environment, { stat = "p95", label = "応答 p95 (ms)" }],
          [var.namespace, "RequestCount", "Environment", var.environment, { stat = "Sum", yAxis = "right", label = "要求数" }],
        ]
      }
    },
    {
      type = "metric", x = 12, y = 0, width = 12, height = 6
      properties = {
        title  = "5xx の割合・追記の競合率（0〜1）"
        region = var.region
        view   = "timeSeries"
        period = 60
        metrics = [
          [var.namespace, "ServerError", "Environment", var.environment, { stat = "Average", label = "5xx の割合" }],
          [var.namespace, "ConcurrencyConflict", "Environment", var.environment, { stat = "Average", label = "追記の競合率" }],
        ]
      }
    },
    {
      type = "metric", x = 0, y = 6, width = 12, height = 6
      properties = {
        title   = "主要な操作の成功（研修中の停止の検知）"
        region  = var.region
        view    = "timeSeries"
        period  = 10
        metrics = [[var.namespace, "MainOperationSuccess", "Environment", var.environment, { stat = "Sum", label = "成功数（10 秒）" }]]
      }
    },
    {
      type = "metric", x = 12, y = 6, width = 12, height = 6
      properties = {
        title  = "再試行の上限超過・削除の放棄"
        region = var.region
        view   = "timeSeries"
        period = 300
        metrics = [
          [var.namespace, "RetryExhausted", "Environment", var.environment, { stat = "Sum", label = "再試行の上限超過" }],
          [var.namespace, "RetentionAbandonedGames", "Environment", var.environment, { stat = "Maximum", label = "削除の放棄" }],
        ]
      }
    },
    {
      type = "metric", x = 0, y = 12, width = 12, height = 6
      properties = {
        title  = "投影の整合（日次の検査）"
        region = var.region
        view   = "timeSeries"
        period = 86400
        metrics = [
          [var.namespace, "ProjectionMismatchGames", "Environment", var.environment, { stat = "Maximum", label = "不一致のゲーム" }],
          [var.namespace, "ProjectionLagGames", "Environment", var.environment, { stat = "Maximum", label = "版が遅れたゲーム" }],
          [var.namespace, "ProjectionUncheckedGames", "Environment", var.environment, { stat = "Maximum", label = "検査できなかったゲーム" }],
        ]
      }
    },
    {
      type = "metric", x = 12, y = 12, width = 12, height = 6
      properties = {
        title  = "接続プール（Rust にヒープ・GC の指標はない。メモリは B1 で実測して足す）"
        region = var.region
        view   = "timeSeries"
        period = 60
        metrics = [
          [var.namespace, "DbPoolUtilizationPercent", "Environment", var.environment, { stat = "Maximum", label = "接続プール (%)" }],
        ]
      }
    },
    {
      type = "metric", x = 0, y = 18, width = 12, height = 6
      properties = {
        title   = "合成監視の成功率"
        region  = var.region
        view    = "timeSeries"
        period  = 60
        metrics = [["CloudWatchSynthetics", "SuccessPercent", "CanaryName", local.canary_name, { stat = "Average" }]]
      }
    },
    {
      type = "alarm", x = 12, y = 18, width = 12, height = 6
      properties = {
        title  = "アラームの状態"
        alarms = concat([for a in aws_cloudwatch_metric_alarm.app : a.arn], [aws_cloudwatch_metric_alarm.no_healthy_targets.arn, aws_cloudwatch_metric_alarm.task_cpu.arn])
      }
    },
  ]
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({ widgets = local.widgets })
}
