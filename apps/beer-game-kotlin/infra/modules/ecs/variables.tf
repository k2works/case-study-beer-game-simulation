variable "name" { type = string }

variable "environment" {
  type        = string
  description = "APP_ENV に渡す値（staging または production）"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment は staging または production（H2 を許す local・test は、この定義の対象外）。"
  }
}

variable "subnet_ids" { type = list(string) }
variable "task_security_group_id" { type = string }
variable "target_group_arn" { type = string }
variable "allowed_origin" { type = string }

variable "db_url" {
  type        = string
  description = "JDBC の接続 URL（資格を含まない）"
}

variable "image" {
  type        = string
  description = "初期のイメージ（ダイジェスト固定）。以降はパイプラインが差し替える"
}

variable "secret_arns" { type = list(string) }
variable "database_secret_arn" { type = string }
variable "credential_key_secret_arn" { type = string }
variable "idempotency_key_secret_arn" { type = string }
variable "response_key_secret_arn" { type = string }

variable "container_port" {
  type    = number
  default = 8080
}

# JVM のタスクのサイズ。設計書（ID2）の初期案。ヒープ・再生の所要時間・GC の測定の後に決める
variable "cpu" {
  type        = number
  default     = 1024
  description = "初期案: 1 vCPU（実測で見直す）"
}

variable "memory" {
  type        = number
  default     = 2048
  description = "初期案: 2 GiB（実測で見直す）"
}

variable "migrate_cpu" {
  type        = number
  default     = 512
  description = "マイグレーション用。JVM が起動できる大きさの初期案（根拠となる実測は無い）"
}

variable "migrate_memory" {
  type        = number
  default     = 1024
  description = "マイグレーション用の初期案（実測で見直す）"
}

variable "stop_timeout" {
  type        = number
  default     = 40
  description = "SIGTERM から強制終了までの猶予（秒。Fargate は最大 120）。ALB の deregistration_delay より少し長い初期案"
}

variable "health_check_grace_period" {
  type        = number
  default     = 120
  description = "ヘルスチェックの猶予期間（秒）。JVM の起動時間の実測前の初期案"
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "min_count" {
  type    = number
  default = 1
}

variable "max_count" {
  type    = number
  default = 1
}

variable "cpu_target_percent" {
  type    = number
  default = 60
}

variable "scale_out_cooldown" {
  type        = number
  default     = 180
  description = "初期案（秒）。JVM の起動直後の CPU の高まりを追加の理由と誤解しないため。測定で決める"
}

variable "scale_in_cooldown" {
  type        = number
  default     = 300
  description = "初期案（秒）"
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

# ---- 更新方式（B14） ----
variable "deployment_strategy" {
  type        = string
  default     = "ROLLING"
  description = "API サービスの更新方式。ステージングは ROLLING、本番は BLUE_GREEN（ECS の組み込み。設計書の CodeDeploy 案の代わりの AI の提案。未承認）"

  validation {
    condition     = contains(["ROLLING", "BLUE_GREEN"], var.deployment_strategy)
    error_message = "deployment_strategy は ROLLING または BLUE_GREEN。"
  }
}

variable "alternate_target_group_arn" {
  type        = string
  default     = ""
  description = "BLUE_GREEN の、もう一方の対象グループ"
}

variable "production_listener_rule_arn" {
  type        = string
  default     = ""
  description = "BLUE_GREEN で、ECS が対象グループを切り替える ALB のリスナールール"
}

variable "bake_time_in_minutes" {
  type        = number
  default     = 10
  description = "切り替え後、旧版を残して様子を見る時間（分）。この間にアラームが鳴れば、旧版へ戻す。初期案"
}

variable "deployment_alarm_names" {
  type        = list(string)
  default     = []
  description = "更新中に監視するアラームの名前。鳴ると自動で戻す（ROLLING・BLUE_GREEN の両方）"
}

# ---- 保守・定期のタスク（B14） ----
variable "batch_cpu" {
  type        = number
  default     = 512
  description = "retention・verify-projections・rebuild-projections のタスクの CPU。JVM が起動できる大きさの初期案（実測は無い）"
}

variable "batch_memory" {
  type        = number
  default     = 1024
  description = "同メモリの初期案（実測で見直す）"
}

variable "deleter_role" {
  type        = string
  default     = "beergame_deleter"
  description = "retention が SET ROLE する削除用のロール（マイグレーション V101 が作る NOLOGIN のロール）"
}

variable "scheduled_tasks_enabled" {
  type        = bool
  default     = true
  description = "定期の起動を有効にするか。適用の直後は false にして、手動で 1 回確かめてから true にしてよい"
}

variable "retention_schedule" {
  type        = string
  default     = "rate(5 minutes)"
  description = "保持削除の掃引の間隔（B11。再試行の最初の間隔 5 分に合わせた）"
}

variable "verify_schedule" {
  type        = string
  default     = "cron(0 18 * * ? *)"
  description = "投影の整合の日次検査（UTC 18:00 = 日本時間 03:00。研修のない時間帯。心拍のアラームの期間は UTC の 1 日）"
}
