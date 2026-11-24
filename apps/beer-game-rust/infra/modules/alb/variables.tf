variable "name" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "task_security_group_id" { type = string }

variable "container_port" {
  type        = number
  default     = 8080
  description = "アプリの待ち受けポート（ServerConfig の既定 PORT = 8080）"
}

variable "health_check_path" {
  type        = string
  default     = "/api/v1/ready"
  description = "B1 の実装のパス（設計書の図の /ready は古い。architecture-infrastructure.md の未決事項を参照）"
}

variable "deregistration_delay" {
  type        = number
  default     = 30
  description = "登録解除の遅延（秒）。初期案"
}

variable "origin_verify_value" {
  type      = string
  sensitive = true
}
