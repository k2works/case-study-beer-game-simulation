# ECS Fargate: API サービス（ローリング更新、失敗したら自動で戻す）と、マイグレーション用の 1 回限りのタスク定義。
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

# タスクロール: アプリ自身の権限（今は何も要らない）
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

locals {
  common_secrets = [
    { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
  ]
  api_secrets = concat(local.common_secrets, [
    { name = "CREDENTIAL_HMAC_KEY", valueFrom = var.credential_hmac_key_secret_arn },
    { name = "IDEMPOTENCY_KEY", valueFrom = var.idempotency_key_secret_arn },
  ])
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
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(var.container_port) },
      { name = "ALLOWED_ORIGIN", value = var.allowed_origin },
    ]
    secrets = local.api_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

# マイグレーション: 同じイメージで、コマンドだけ変える。デプロイの一部として 1 回限りで実行する
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = var.image
    essential = true
    command   = ["node_modules/.bin/node-pg-migrate", "-m", "migrations", "--migrations-table", "pgmigrations", "up"]
    secrets   = local.common_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migrate.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  health_check_grace_period_seconds  = 30
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # 新しい版が健全にならなければ、直前の版へ自動で戻す
  deployment_circuit_breaker {
    enable   = true
    rollback = true
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
  }

  # デプロイはパイプラインが行う（イメージのダイジェストを差し替える）。Terraform は差分として扱わない
  lifecycle {
    ignore_changes = [task_definition]
  }
}

# 保持の定期タスク: 期限に達したゲームを削除する（docs/development/beer-game2/bolt_10_plan.md）。
# 同じイメージで、コマンドだけ変える。EventBridge Scheduler が 5 分ごとに起動する
resource "aws_cloudwatch_log_group" "retention" {
  name              = "/ecs/${var.name}/retention"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "retention" {
  family                   = "${var.name}-retention"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "retention"
    image     = var.image
    essential = true
    command   = ["node", "dist/retention.js"]
    secrets   = local.common_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.retention.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "retention"
      }
    }
  }])
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

# スケジューラーの実行ロール: 保持のタスクの起動と、タスクのロールの受け渡しだけ
resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-retention-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name = "run-retention-task"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = [aws_ecs_task_definition.retention.arn_without_revision, "${aws_ecs_task_definition.retention.arn_without_revision}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
      },
    ]
  })
}

resource "aws_scheduler_schedule" "retention" {
  name                = "${var.name}-retention"
  schedule_expression = var.retention_schedule

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.retention.arn_without_revision
      launch_type         = "FARGATE"

      network_configuration {
        subnets          = var.subnet_ids
        security_groups  = [var.task_security_group_id]
        assign_public_ip = var.assign_public_ip
      }
    }

    retry_policy {
      maximum_retry_attempts = 0 # 再試行は、次の起動で行う（アプリが試行回数を数える）
    }
  }
}
