terraform {
  required_version = ">= 1.8.0"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }
}
variable "environment" { type = string }
variable "region" { type = string; default = "ap-northeast-1" }
variable "database_secret_arn" { type = string; sensitive = true }
provider "aws" { region = var.region }

resource "aws_vpc" "main" { cidr_block = "10.40.0.0/16"; enable_dns_hostnames = true; tags = { Name = "beer-game-${var.environment}" } }
resource "aws_ecs_cluster" "main" { name = "beer-game-${var.environment}" }
resource "aws_cloudwatch_log_group" "app" { name = "/beer-game/${var.environment}"; retention_in_days = var.environment == "production" ? 90 : 14 }
resource "aws_db_instance" "postgres" {
  identifier = "beer-game-${var.environment}"
  engine = "postgres"
  engine_version = "17"
  instance_class = "db.t4g.small"
  allocated_storage = 20
  multi_az = true
  storage_encrypted = true
  backup_retention_period = 7
  deletion_protection = var.environment == "production"
  manage_master_user_password = true
  username = "beer_game"
  skip_final_snapshot = var.environment != "production"
}
# Private ECS subnets use NAT gateway or VPC endpoints for ECR, Logs, Secrets Manager and S3.
# Production ECS services are deployed through CodeDeploy blue/green; staging uses rolling updates.
