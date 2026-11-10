output "credential_hmac_key_arn" { value = aws_secretsmanager_secret.credential_hmac_key.arn }
output "idempotency_key_arn" { value = aws_secretsmanager_secret.idempotency_key.arn }
output "database_url_arn" { value = aws_secretsmanager_secret.database_url.arn }
output "secret_arns" {
  value = [
    aws_secretsmanager_secret.credential_hmac_key.arn,
    aws_secretsmanager_secret.idempotency_key.arn,
    aws_secretsmanager_secret.database_url.arn,
  ]
}
# ALB と CloudFront の間の合言葉（オリジンの検証用ヘッダー）
output "origin_verify_value" {
  value     = random_password.origin_verify.result
  sensitive = true
}
