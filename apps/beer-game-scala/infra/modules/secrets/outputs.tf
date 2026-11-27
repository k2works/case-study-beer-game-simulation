output "credential_key_arn" { value = aws_secretsmanager_secret.credential_key.arn }
output "database_arn" { value = aws_secretsmanager_secret.database.arn }

output "secret_arns" {
  description = "実行ロールに参照を許す秘密（この環境の分だけ）"
  value = [
    aws_secretsmanager_secret.credential_key.arn,
    aws_secretsmanager_secret.database.arn,
  ]
}

# ALB と CloudFront の間の合言葉（オリジンの検証用ヘッダー）
output "origin_verify_value" {
  value     = random_password.origin_verify.result
  sensitive = true
}
