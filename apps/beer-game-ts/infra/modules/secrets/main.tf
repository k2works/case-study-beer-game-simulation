# 秘密情報。値は Terraform が乱数で生成し、Secrets Manager に置く（リポジトリには置かない）。
# 注意: 生成した値は Terraform の状態に入る。状態は暗号化したバケットに置き、アクセスを制限する。
resource "random_id" "credential_hmac_key" {
  byte_length = 32
}

resource "random_id" "idempotency_key" {
  byte_length = 32
}

resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "credential_hmac_key" {
  name                    = "${var.name}/credential-hmac-key"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "credential_hmac_key" {
  secret_id     = aws_secretsmanager_secret.credential_hmac_key.id
  secret_string = random_id.credential_hmac_key.hex
}

resource "aws_secretsmanager_secret" "idempotency_key" {
  name                    = "${var.name}/idempotency-key"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "idempotency_key" {
  secret_id     = aws_secretsmanager_secret.idempotency_key.id
  secret_string = random_id.idempotency_key.hex
}

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name}/database-url"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = var.database_url
}
