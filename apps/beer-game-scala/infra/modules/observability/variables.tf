variable "name" { type = string }

variable "environment" {
  type        = string
  description = "メトリクスのディメンション Environment の値（APP_ENV と同じ。staging または production）"
}

variable "region" { type = string }

variable "namespace" {
  type        = string
  default     = "BeerGame"
  description = "アプリのメトリクスの名前空間（adapter-http の METRIC_NAMESPACE と同じ）"
}

variable "alb_arn_suffix" { type = string }
variable "target_group_arn_suffix" { type = string }

variable "alternate_target_group_arn_suffix" {
  type        = string
  default     = ""
  description = "ブルー/グリーンのもう一方の対象グループ（B14）。空なら、1 つだけを見る（ローリングのステージング）"
}
variable "cluster_name" { type = string }
variable "service_name" { type = string }

variable "public_domain" {
  type        = string
  description = "合成監視が /api/v1/ready を取得する、利用者が開くドメイン（CloudFront 経由）"
}

variable "critical_emails" {
  type        = list(string)
  default     = []
  description = "重大の通知の宛先（メール）。購読は、宛先の確認が要る（適用後に、確認のメールを承認する）"
}

variable "warning_emails" {
  type        = list(string)
  default     = []
  description = "警告の通知の宛先（メール）"
}

variable "training_alarms_enabled" {
  type        = bool
  default     = false
  description = "研修中だけ通知するアラーム（main-operation-stall）の通知を有効にするか。研修の開始と終了で切り替える（手順書）"
}

variable "canary_runtime_version" {
  type        = string
  default     = "syn-nodejs-puppeteer-9.1"
  description = "CloudWatch Synthetics のランタイム。AWS 上で未確認（適用の前に、対応する版を確かめる）"
}
