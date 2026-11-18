# ECS Fargate（JVM）: API サービスと、1 回限りのタスク定義（migrate・retention・verify-projections・rebuild-projections）。
# 同じイメージを、起動引数（モード）で切り替える。SQS は使わない（設計書）。
# API サービスの更新方式（B14）: ステージングは ROLLING（サーキットブレーカーで自動で戻す）、本番は BLUE_GREEN
# （ECS の組み込みのブルー/グリーン。新しい版を別の対象グループで起動し、健全を確かめてから切り替え、待ち時間の間は旧版を残す）。
# 定期の起動（B14）: retention は 5 分ごと、verify-projections は日次（研修のない時間帯）。EventBridge Scheduler で定義する。
data "aws_region" "current" {}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name}/api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${var.name}/migrate"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "retention" {
  name              = "/ecs/${var.name}/retention"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "verify_projections" {
  name              = "/ecs/${var.name}/verify-projections"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "rebuild_projections" {
  name              = "/ecs/${var.name}/rebuild-projections"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# 実行ロール: イメージの取得、ログの出力、秘密情報の注入（この環境の秘密だけ）
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets.json
}

# タスクロール: アプリ自身の権限（今は何も要らない。SQS・S3 などを使わない）
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

locals {
  # ServerConfig（アプリの設定）が読む環境変数。値は秘密を含まない。
  # APP_ENV は local|test|staging|production の 4 値（AppEnv）。DB_KIND は postgres に固定（H2 は起動時に拒否される。二重の防御）
  environment = [
    { name = "APP_ENV", value = var.environment },
    { name = "DB_KIND", value = "postgres" },
    { name = "DB_URL", value = var.db_url },
    { name = "HOST", value = "0.0.0.0" },
    { name = "PORT", value = tostring(var.container_port) },
    { name = "ALLOWED_ORIGINS", value = var.allowed_origin },
    # PostgreSQL の api は、起動時にマイグレーションを適用しない（migrate モードの 1 回限りのタスクが適用する）
    { name = "MIGRATE_ON_START", value = "false" },
  ]

  # 秘密情報（Secrets Manager から注入）。DB の資格は JSON のキーごとに取り出す（"<ARN>:<キー>::"）
  # ServerConfig.load は、migrate モードでも、local 以外では 3 つの鍵と ALLOWED_ORIGINS を必須とする。
  # そのため api と migrate で同じ環境変数と秘密を渡す。
  secrets = [
    { name = "DB_USER", valueFrom = "${var.database_secret_arn}:username::" },
    { name = "DB_PASSWORD", valueFrom = "${var.database_secret_arn}:password::" },
    { name = "CREDENTIAL_KEY", valueFrom = var.credential_key_secret_arn },
    { name = "IDEMPOTENCY_KEY", valueFrom = var.idempotency_key_secret_arn },
    { name = "RESPONSE_KEY", valueFrom = var.response_key_secret_arn },
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name         = "api"
    image        = var.image
    essential    = true
    command      = ["api"] # 起動モード。Dockerfile の ENTRYPOINT との組み合わせは未確認（Step 1 と整合させる）
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    # SIGTERM の後、強制終了までの猶予。ALB の登録解除の遅延と整合させる（初期案）
    stopTimeout = var.stop_timeout
    environment = local.environment
    secrets     = local.secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

# マイグレーション: 同じイメージで、モードだけ変える。デプロイの一部として、アプリの起動前に 1 回限りで実行する
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.migrate_cpu
  memory                   = var.migrate_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name        = "migrate"
    image       = var.image
    essential   = true
    command     = ["migrate"]
    environment = local.environment
    secrets     = local.secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migrate.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}

# 保守・定期のタスク（B11・B12・B14）。モードは app の Main.kt の MODES と一致させる（ProductionDefinitionSpec が検査する）。
# retention は、削除用のロール（DB_DELETER_ROLE。V101 が作る NOLOGIN のロール）に SET ROLE して動く。
# 所有者のログインが SET ROLE できるか（GRANT ... WITH SET TRUE）は、AWS 上で未確認（運用手順書の適用前の確認項目）。
locals {
  batch_tasks = {
    "retention" = {
      command     = ["retention"]
      log_group   = aws_cloudwatch_log_group.retention.name
      environment = concat(local.environment, [{ name = "DB_DELETER_ROLE", value = var.deleter_role }])
    }
    "verify-projections" = {
      command     = ["verify-projections"]
      log_group   = aws_cloudwatch_log_group.verify_projections.name
      environment = local.environment
    }
    "rebuild-projections" = {
      command     = ["rebuild-projections"]
      log_group   = aws_cloudwatch_log_group.rebuild_projections.name
      environment = local.environment
    }
  }
}

resource "aws_ecs_task_definition" "batch" {
  for_each = local.batch_tasks

  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.batch_cpu
  memory                   = var.batch_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name        = each.key
    image       = var.image
    essential   = true
    command     = each.value.command
    environment = each.value.environment
    secrets     = local.secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = each.value.log_group
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
  # イメージはパイプラインが新しい版を登録して差し替える（スケジュールは、版を付けない ARN で最新の有効な版を使う）
}

# ブルー/グリーンで、ECS が負荷分散器を操作するためのロール（BLUE_GREEN のときだけ使う）
data "aws_iam_policy_document" "assume_ecs" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "infrastructure" {
  name               = "${var.name}-ecs-infrastructure"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs.json
}

resource "aws_iam_role_policy_attachment" "infrastructure" {
  role       = aws_iam_role.infrastructure.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonECSInfrastructureRolePolicyForLoadBalancers"
}

# 定期の起動（EventBridge Scheduler）
data "aws_iam_policy_document" "assume_scheduler" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.assume_scheduler.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "RunScheduledTasks"
    actions   = ["ecs:RunTask"]
    resources = [for key in ["retention", "verify-projections"] : "${aws_ecs_task_definition.batch[key].arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "run-scheduled-tasks"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

locals {
  schedules = {
    "retention"          = var.retention_schedule
    "verify-projections" = var.verify_schedule
  }
}

resource "aws_scheduler_schedule" "batch" {
  for_each = local.schedules

  name                         = "${var.name}-${each.key}"
  description                  = "${each.key} を定期に実行する（B14）"
  schedule_expression          = each.value
  schedule_expression_timezone = "UTC"
  state                        = var.scheduled_tasks_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.batch[each.key].arn_without_revision
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = var.subnet_ids
        security_groups  = [var.task_security_group_id]
        assign_public_ip = var.assign_public_ip
      }
    }

    # 失敗は、メトリクスの欠測（心拍のアラーム）で知る。同じ起動を重ねて再試行しない
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 60
    }
  }
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # JVM の起動に時間がかかる。猶予期間は、起動時間（コンテナの開始から /api/v1/ready の成功まで）の
  # 実測の p95 より長く取る。値は初期案で、実測（NF-P16: p95 30 秒以下は提案）で見直す
  health_check_grace_period_seconds  = var.health_check_grace_period
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # ROLLING: 新しい版が健全にならなければ、直前の版へ自動で戻す（サーキットブレーカー）。BLUE_GREEN では使えない
  dynamic "deployment_circuit_breaker" {
    for_each = var.deployment_strategy == "ROLLING" ? [1] : []
    content {
      enable   = true
      rollback = true
    }
  }

  # BLUE_GREEN: 新しい版（green）を別の対象グループで起動し、健全を確かめてから、待ち時間つきで切り替える。
  # 待ち時間（bake）の間は旧版（blue）を残し、アラームが鳴れば自動で戻す。実際の切り替えと戻しは AWS 上で未確認
  dynamic "deployment_configuration" {
    for_each = var.deployment_strategy == "BLUE_GREEN" ? [1] : []
    content {
      strategy             = "BLUE_GREEN"
      bake_time_in_minutes = var.bake_time_in_minutes
    }
  }

  dynamic "alarms" {
    for_each = length(var.deployment_alarm_names) > 0 ? [1] : []
    content {
      alarm_names = var.deployment_alarm_names
      enable      = true
      rollback    = true
    }
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.task_security_group_id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = var.container_port

    dynamic "advanced_configuration" {
      for_each = var.deployment_strategy == "BLUE_GREEN" ? [1] : []
      content {
        alternate_target_group_arn = var.alternate_target_group_arn
        production_listener_rule   = var.production_listener_rule_arn
        role_arn                   = aws_iam_role.infrastructure.arn
      }
    }
  }

  # デプロイはパイプラインが行う（タスク定義の版を差し替える）。台数は自動増減が決める。Terraform は差分として扱わない
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

# 自動増減: CPU 60% を目標に min〜max。JVM は起動直後に CPU が高まる（クラスの読み込みと JIT）ため、
# 増やした直後に追加で増やさないよう、増やす側にもクールダウンを置く。値は初期案（測定で決める）
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  resource_id        = aws_appautoscaling_target.api.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_out_cooldown = var.scale_out_cooldown
    scale_in_cooldown  = var.scale_in_cooldown

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
