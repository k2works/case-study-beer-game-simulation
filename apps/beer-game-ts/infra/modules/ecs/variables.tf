variable "name" { type = string }
variable "subnet_ids" { type = list(string) }
variable "task_security_group_id" { type = string }
variable "target_group_arn" { type = string }
variable "allowed_origin" { type = string }

variable "image" {
  type        = string
  description = "初期のイメージ（ダイジェスト固定）。以降はパイプラインが差し替える"
}

variable "secret_arns" { type = list(string) }
variable "database_url_secret_arn" { type = string }
variable "credential_hmac_key_secret_arn" { type = string }
variable "idempotency_key_secret_arn" { type = string }

variable "container_port" {
  type    = number
  default = 3000
}

variable "cpu" {
  type    = number
  default = 256
}

variable "memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "assign_public_ip" {
  type        = bool
  default     = true
  description = "NAT を置かない構成では true（公開サブネット。セキュリティグループで ALB からのみ許可）"
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "retention_schedule" {
  description = "保持の定期タスクの起動間隔（EventBridge Scheduler の式）"
  type        = string
  default     = "rate(5 minutes)"
}
