terraform {
  required_version = ">= 1.8.0"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }
}
variable "environment" { type = string }
variable "region" {
  type    = string
  default = "ap-northeast-1"
}
variable "database_secret_arn" {
  type      = string
  sensitive = true
}
variable "retention_database_url_secret_arn" { type = string }
variable "retention_hmac_key_secret_arn" { type = string }
variable "retention_container_image" { type = string }
variable "retention_private_subnet_ids" { type = list(string) }
variable "retention_worker_security_group_id" { type = string }
provider "aws" { region = var.region }

resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "beer-game-${var.environment}" }
}
resource "aws_ecs_cluster" "main" { name = "beer-game-${var.environment}" }
resource "aws_cloudwatch_log_group" "app" {
  name              = "/beer-game/${var.environment}"
  retention_in_days = var.environment == "production" ? 90 : 14
}
resource "aws_kms_key" "learning" {
  description         = "Beer Game learning projections and exports"
  enable_key_rotation = true
}
resource "aws_kms_key" "retention" {
  description         = "Beer Game retention deletion queues"
  enable_key_rotation = true
}
locals {
  deletion_owners = toset(["u1-walking-skeleton", "u2-session-continuity", "u3-learning-view"])
}
resource "aws_sqs_queue" "deletion_owner_dlq" {
  for_each          = local.deletion_owners
  name              = "beer-game-deletion-${each.key}-dlq-${var.environment}"
  kms_master_key_id = aws_kms_key.retention.arn
}
resource "aws_sqs_queue" "deletion_owner" {
  for_each                   = local.deletion_owners
  name                       = "beer-game-deletion-${each.key}-${var.environment}"
  kms_master_key_id          = aws_kms_key.retention.arn
  visibility_timeout_seconds = 120
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.deletion_owner_dlq[each.key].arn
    maxReceiveCount     = 6
  })
}
resource "aws_sqs_queue" "deletion_completion_dlq" {
  name              = "beer-game-deletion-completion-dlq-${var.environment}"
  kms_master_key_id = aws_kms_key.retention.arn
}
resource "aws_sqs_queue" "deletion_completion_v2" {
  name                       = "beer-game-deletion-completion-v2-${var.environment}"
  kms_master_key_id          = aws_kms_key.retention.arn
  visibility_timeout_seconds = 120
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.deletion_completion_dlq.arn
    maxReceiveCount     = 6
  })
}
resource "aws_sqs_queue" "deletion_completion_v1_quarantine" {
  name              = "beer-game-deletion-completion-v1-quarantine-${var.environment}"
  kms_master_key_id = aws_kms_key.retention.arn
}
resource "aws_cloudwatch_log_group" "retention" {
  name              = "/beer-game/${var.environment}/retention"
  retention_in_days = var.environment == "production" ? 30 : 14
}
resource "aws_iam_role" "retention_execution" {
  name               = "beer-game-retention-execution-${var.environment}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "retention_execution" {
  role       = aws_iam_role.retention_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "retention_execution_secrets" {
  role   = aws_iam_role.retention_execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue", "kms:Decrypt"], Resource = [var.retention_database_url_secret_arn, var.retention_hmac_key_secret_arn, aws_kms_key.retention.arn] }] })
}
resource "aws_iam_role" "retention_task" {
  name               = "beer-game-retention-task-${var.environment}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "retention_task" {
  role   = aws_iam_role.retention_task.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = concat([aws_sqs_queue.deletion_completion_v2.arn, aws_sqs_queue.deletion_completion_v1_quarantine.arn], [for queue in aws_sqs_queue.deletion_owner : queue.arn]) }, { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = [aws_kms_key.retention.arn] }] })
}
locals {
  retention_secrets = [
    { name = "DATABASE_URL", valueFrom = var.retention_database_url_secret_arn },
    { name = "RETENTION_HMAC_KEY", valueFrom = var.retention_hmac_key_secret_arn }
  ]
}
resource "aws_ecs_task_definition" "retention_coordinator" {
  family                   = "beer-game-retention-coordinator-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.retention_execution.arn
  task_role_arn            = aws_iam_role.retention_task.arn
  container_definitions = jsonencode([{ name = "coordinator", image = var.retention_container_image, essential = true,
    command = ["npm", "run", "retention:coordinator"], secrets = local.retention_secrets,
    environment = concat([for owner, queue in aws_sqs_queue.deletion_owner : { name = "DELETION_QUEUE_${upper(replace(owner, "-", "_"))}", value = queue.url }], [
      { name = "DELETION_COMPLETION_QUEUE_URL", value = aws_sqs_queue.deletion_completion_v2.url },
      { name = "DELETION_QUARANTINE_QUEUE_URL", value = aws_sqs_queue.deletion_completion_v1_quarantine.url }
    ]),
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.retention.name, awslogs-region = var.region, awslogs-stream-prefix = "coordinator" } }
  }])
}
resource "aws_ecs_task_definition" "retention_owner" {
  for_each                 = local.deletion_owners
  family                   = "beer-game-retention-${each.key}-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.retention_execution.arn
  task_role_arn            = aws_iam_role.retention_task.arn
  container_definitions = jsonencode([{ name = "owner", image = var.retention_container_image, essential = true,
    command = ["npm", "run", "retention:owner"], secrets = local.retention_secrets,
    environment = [
      { name = "DELETION_OWNER_UNIT", value = each.key },
      { name = "DELETION_OWNER_QUEUE_URL", value = aws_sqs_queue.deletion_owner[each.key].url },
      { name = "DELETION_COMPLETION_QUEUE_URL", value = aws_sqs_queue.deletion_completion_v2.url }
    ],
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.retention.name, awslogs-region = var.region, awslogs-stream-prefix = each.key } }
  }])
}
resource "aws_iam_role" "retention_scheduler" {
  name               = "beer-game-retention-scheduler-${var.environment}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "retention_scheduler" {
  role = aws_iam_role.retention_scheduler.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "ecs:RunTask", Resource = concat([aws_ecs_task_definition.retention_coordinator.arn], [for task in aws_ecs_task_definition.retention_owner : task.arn]) },
    { Effect = "Allow", Action = "iam:PassRole", Resource = [aws_iam_role.retention_execution.arn, aws_iam_role.retention_task.arn] }
  ] })
}
resource "aws_cloudwatch_event_rule" "retention_due" {
  name                = "beer-game-retention-due-${var.environment}"
  schedule_expression = "rate(5 minutes)"
}
resource "aws_cloudwatch_event_target" "retention_due" {
  rule     = aws_cloudwatch_event_rule.retention_due.name
  arn      = aws_ecs_cluster.main.arn
  role_arn = aws_iam_role.retention_scheduler.arn
  ecs_target {
    task_definition_arn = aws_ecs_task_definition.retention_coordinator.arn
    launch_type         = "FARGATE"
    task_count          = 1
    network_configuration {
      subnets          = var.retention_private_subnet_ids
      security_groups  = [var.retention_worker_security_group_id]
      assign_public_ip = false
    }
  }
}
resource "aws_cloudwatch_event_rule" "retention_owner_poll" {
  name                = "beer-game-retention-owner-poll-${var.environment}"
  schedule_expression = "rate(1 minute)"
}
resource "aws_cloudwatch_event_target" "retention_owner_poll" {
  for_each  = local.deletion_owners
  rule      = aws_cloudwatch_event_rule.retention_owner_poll.name
  target_id = each.key
  arn       = aws_ecs_cluster.main.arn
  role_arn  = aws_iam_role.retention_scheduler.arn
  ecs_target {
    task_definition_arn = aws_ecs_task_definition.retention_owner[each.key].arn
    launch_type         = "FARGATE"
    task_count          = 1
    network_configuration {
      subnets          = var.retention_private_subnet_ids
      security_groups  = [var.retention_worker_security_group_id]
      assign_public_ip = false
    }
  }
}
resource "aws_sqs_queue" "learning_dlq" {
  name              = "beer-game-learning-dlq-${var.environment}"
  kms_master_key_id = aws_kms_key.learning.arn
}
resource "aws_sqs_queue" "learning" {
  name                       = "beer-game-learning-${var.environment}"
  kms_master_key_id          = aws_kms_key.learning.arn
  visibility_timeout_seconds = 60
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.learning_dlq.arn, maxReceiveCount = 5 })
}
resource "aws_s3_bucket" "exports" { bucket = "beer-game-exports-${var.environment}" }
resource "aws_s3_bucket_public_access_block" "exports" {
  bucket                  = aws_s3_bucket.exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.learning.arn
    }
  }
}
resource "aws_db_instance" "postgres" {
  identifier                  = "beer-game-${var.environment}"
  engine                      = "postgres"
  engine_version              = "17"
  instance_class              = "db.t4g.small"
  allocated_storage           = 20
  multi_az                    = true
  storage_encrypted           = true
  backup_retention_period     = 7
  deletion_protection         = var.environment == "production"
  manage_master_user_password = true
  username                    = "beer_game"
  skip_final_snapshot         = var.environment != "production"
}
# Private ECS subnets use NAT gateway or VPC endpoints for ECR, Logs, Secrets Manager and S3.
# Production ECS services are deployed through CodeDeploy blue/green; staging uses rolling updates.

# U5 single-origin browser entry. The API service attaches its tasks to api_target_group_arn.
variable "api_public_subnet_ids" { type = list(string) }
variable "api_alb_security_group_id" { type = string }
variable "api_origin_domain_name" { type = string }
variable "api_tls_certificate_arn" { type = string }
variable "public_zone_id" { type = string }

data "aws_caller_identity" "current" {}
data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_cache_policy" "optimized" { name = "Managed-CachingOptimized" }

resource "aws_lb" "api" {
  name               = "beer-game-api-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.api_alb_security_group_id]
  subnets            = var.api_public_subnet_ids
  idle_timeout       = 60
}

resource "aws_lb_target_group" "api" {
  name        = "beer-game-api-${var.environment}"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "api_https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.api_tls_certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_route53_record" "api_origin" {
  zone_id = var.public_zone_id
  name    = var.api_origin_domain_name
  type    = "A"
  alias {
    name                   = aws_lb.api.dns_name
    zone_id                = aws_lb.api.zone_id
    evaluate_target_health = true
  }
}

resource "aws_s3_bucket" "web" {
  bucket = "beer-game-web-${var.environment}-${data.aws_caller_identity.current.account_id}"
}
resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "beer-game-web-${var.environment}"
  description                       = "Private browser assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_request_policy" "api" {
  name = "beer-game-api-${var.environment}"
  cookies_config { cookie_behavior = "all" }
  query_strings_config { query_string_behavior = "all" }
  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Origin", "Referer", "Idempotency-Key", "If-Match", "Last-Event-ID"]
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }
  origin {
    domain_name = var.api_origin_domain_name
    origin_id   = "api-alb"
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }
  default_cache_behavior {
    target_origin_id       = "web-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api-alb"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
    compress                 = false
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate { cloudfront_default_certificate = true }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn } }
    }]
  })
}

output "api_target_group_arn" { value = aws_lb_target_group.api.arn }
output "web_bucket_name" { value = aws_s3_bucket.web.id }
output "web_cloudfront_domain_name" { value = aws_cloudfront_distribution.web.domain_name }

variable "ops_alert_email" { type = string }
variable "monthly_budget_usd" { type = number }

resource "aws_sns_topic" "api_alerts" {
  name = "beer-game-api-alerts-${var.environment}"
}
resource "aws_sns_topic_subscription" "api_alert_email" {
  topic_arn = aws_sns_topic.api_alerts.arn
  protocol  = "email"
  endpoint  = var.ops_alert_email
}
resource "aws_cloudwatch_metric_alarm" "api_connections" {
  alarm_name          = "beer-game-api-connections-${var.environment}"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "ActiveConnectionCount"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 60
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix }
  alarm_actions       = [aws_sns_topic.api_alerts.arn]
}
resource "aws_budgets_budget" "monthly" {
  name         = "beer-game-${var.environment}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.ops_alert_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.ops_alert_email]
  }
}

# API tasks have no process-affinity. Every command reads and writes the shared
# PostgreSQL aggregate, and SSE reconciles persisted outbox versions.
variable "api_container_image" { type = string }
variable "api_private_subnet_ids" { type = list(string) }
variable "api_task_security_group_id" { type = string }
variable "api_credential_key_secret_arn" { type = string }
variable "api_secret_kms_key_arn" { type = string }

resource "aws_iam_role" "api_execution" {
  name               = "beer-game-api-execution-${var.environment}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "api_execution" {
  role       = aws_iam_role.api_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "api_secrets" {
  role = aws_iam_role.api_execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = [var.retention_database_url_secret_arn, var.retention_hmac_key_secret_arn, var.api_credential_key_secret_arn] },
    { Effect = "Allow", Action = "kms:Decrypt", Resource = [var.api_secret_kms_key_arn] }
  ] })
}
resource "aws_iam_role" "api_task" {
  name               = "beer-game-api-task-${var.environment}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_ecs_task_definition" "api" {
  family                   = "beer-game-api-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.api_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  container_definitions = jsonencode([{ name = "api", image = var.api_container_image, essential = true,
    portMappings = [{ containerPort = 3000, protocol = "tcp" }],
    secrets = [
      { name = "DATABASE_URL", valueFrom = var.retention_database_url_secret_arn },
      { name = "RETENTION_HMAC_KEY", valueFrom = var.retention_hmac_key_secret_arn },
      { name = "GAME_CREDENTIAL_ENCRYPTION_KEY", valueFrom = var.api_credential_key_secret_arn }
    ],
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "ALLOWED_ORIGIN", value = "https://${aws_cloudfront_distribution.web.domain_name}" },
      { name = "API_RATE_LIMIT_PER_MINUTE", value = "6000" }
    ],
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = var.region, awslogs-stream-prefix = "api" } }
  }])
}
resource "aws_ecs_service" "api" {
  name                               = "beer-game-api-${var.environment}"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = 2
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  network_configuration {
    subnets          = var.api_private_subnet_ids
    security_groups  = [var.api_task_security_group_id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.api_https]
}
resource "aws_appautoscaling_target" "api" {
  max_capacity       = 4
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}
resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "beer-game-api-cpu-${var.environment}"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
