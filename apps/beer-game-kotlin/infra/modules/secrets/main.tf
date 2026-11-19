# 秘密情報。値は Terraform が乱数で生成し、Secrets Manager に置く（リポジトリには置かない）。
# 注意: 生成した値は Terraform の状態に入る。状態は暗号化したバケットに置き、アクセスを制限する。
# 暗号化の鍵は AWS 管理の鍵（aws/secretsmanager）。設計書の KMS（顧客管理鍵）は B3 では定義しない。
#
# アプリの鍵（ServerConfig）: CREDENTIAL_KEY・IDEMPOTENCY_KEY・RESPONSE_KEY は、Base64 の 32 バイトで、
# 3 つは別の値にする。random_id の b64_std（32 バイトの乱数の Base64）を使う。
resource "random_id" "credential_key" {
  byte_length = 32
}

resource "random_id" "idempotency_key" {
  byte_length = 32
}

resource "random_id" "response_key" {
  byte_length = 32
}

resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "credential_key" {
  name                    = "${var.name}/credential-key"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "credential_key" {
  secret_id     = aws_secretsmanager_secret.credential_key.id
  secret_string = random_id.credential_key.b64_std
}

resource "aws_secretsmanager_secret" "idempotency_key" {
  name                    = "${var.name}/idempotency-key"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "idempotency_key" {
  secret_id     = aws_secretsmanager_secret.idempotency_key.id
  secret_string = random_id.idempotency_key.b64_std
}

resource "aws_secretsmanager_secret" "response_key" {
  name                    = "${var.name}/response-key"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "response_key" {
  secret_id     = aws_secretsmanager_secret.response_key.id
  secret_string = random_id.response_key.b64_std
}

# DB の資格（JSON）。ECS は "<ARN>:username::" と "<ARN>:password::" で、キーごとに取り出して
# DB_USER・DB_PASSWORD に渡す。ロールごとの別の秘密（設計書）は、ログイン用のロールを分けるときに足す。
resource "aws_secretsmanager_secret" "database" {
  name                    = "${var.name}/database-owner"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "database" {
  secret_id = aws_secretsmanager_secret.database.id
  secret_string = jsonencode({
    username = var.database_username
    password = var.database_password
  })
}
