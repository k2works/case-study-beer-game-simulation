output "endpoint" { value = aws_db_instance.this.address }
output "port" { value = aws_db_instance.this.port }

output "jdbc_url" {
  description = "JDBC の接続 URL（資格を含まない。SSL 必須）。環境変数 DB_URL に渡す"
  value       = "jdbc:postgresql://${aws_db_instance.this.address}:${aws_db_instance.this.port}/${aws_db_instance.this.db_name}?sslmode=require"
}

output "username" { value = aws_db_instance.this.username }

output "password" {
  description = "マスターパスワード。Secrets Manager に置く（DB_PASSWORD）"
  sensitive   = true
  value       = random_password.master.result
}
