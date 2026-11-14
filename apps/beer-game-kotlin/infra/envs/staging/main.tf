locals {
  name = "beer-game-kotlin-${var.environment}"
}

module "network" {
  source = "../../modules/network"
  name   = local.name
}

# ECS タスクのセキュリティグループ（RDS と ALB の双方から参照するため、ここで作る）
resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "ECS タスク: ALB からのみ受ける。外向きは全許可（ECR、Secrets Manager、Logs、RDS）"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group_rule" "tasks_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.tasks.id
  source_security_group_id = module.alb.security_group_id
  protocol                 = "tcp"
  from_port                = 8080
  to_port                  = 8080
}

resource "aws_security_group_rule" "tasks_egress" {
  type              = "egress"
  security_group_id = aws_security_group.tasks.id
  cidr_blocks       = ["0.0.0.0/0"]
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
}

module "ecr" {
  source = "../../modules/ecr"
  name   = local.name
}

module "rds" {
  source                 = "../../modules/rds"
  name                   = local.name
  vpc_id                 = module.network.vpc_id
  subnet_ids             = module.network.private_subnet_ids
  task_security_group_id = aws_security_group.tasks.id

  # ステージング: Single-AZ、削除保護なし。本番は Multi-AZ・削除保護あり
  multi_az            = false
  deletion_protection = false
  skip_final_snapshot = true
}

module "secrets" {
  source                  = "../../modules/secrets"
  name                    = local.name
  database_username       = module.rds.username
  database_password       = module.rds.password
  recovery_window_in_days = 0
}

module "alb" {
  source                 = "../../modules/alb"
  name                   = local.name
  vpc_id                 = module.network.vpc_id
  public_subnet_ids      = module.network.public_subnet_ids
  task_security_group_id = aws_security_group.tasks.id
  origin_verify_value    = module.secrets.origin_verify_value
}

module "web" {
  source              = "../../modules/web"
  name                = local.name
  bucket_name         = var.web_bucket_name
  alb_dns_name        = module.alb.dns_name
  origin_verify_value = module.secrets.origin_verify_value
  force_destroy       = true
}

module "ecs" {
  source                 = "../../modules/ecs"
  name                   = local.name
  environment            = var.environment
  subnet_ids             = module.network.public_subnet_ids
  task_security_group_id = aws_security_group.tasks.id
  target_group_arn       = module.alb.target_group_arn
  allowed_origin         = "https://${module.web.public_domain}"
  image                  = var.image
  db_url                 = module.rds.jdbc_url

  secret_arns                = module.secrets.secret_arns
  database_secret_arn        = module.secrets.database_arn
  credential_key_secret_arn  = module.secrets.credential_key_arn
  idempotency_key_secret_arn = module.secrets.idempotency_key_arn
  response_key_secret_arn    = module.secrets.response_key_arn

  # ステージング: 1 タスク（自動増減なし）。ローリング更新
  desired_count    = 1
  min_count        = 1
  max_count        = 1
  assign_public_ip = true
}

module "github_oidc" {
  source             = "../../modules/github_oidc"
  name               = local.name
  github_repository  = var.github_repository
  environment        = var.environment
  create_provider    = var.create_oidc_provider
  ecr_repository_arn = module.ecr.repository_arn
  ecs_service_arn    = module.ecs.service_arn
  web_bucket_arn     = module.web.bucket_arn
  distribution_arn   = module.web.distribution_arn
  pass_role_arns     = [module.ecs.execution_role_arn, module.ecs.task_role_arn]
  log_group_arns     = module.ecs.log_group_arns
}
