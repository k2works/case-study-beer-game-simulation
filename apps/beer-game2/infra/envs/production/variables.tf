variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "github_repository" {
  type    = string
  default = "k2works/case-study-beer-game-simulation"
}

variable "image" {
  type        = string
  description = "初期のイメージ（ステージングで検証したダイジェスト。<ECR の URL>@sha256:...）。以降はパイプラインが差し替える"
}

variable "web_bucket_name" {
  type        = string
  description = "静的ファイルのバケット名（全世界で一意）"
}

variable "domain_name" {
  type        = string
  description = "独自ドメイン（未決事項 5。本番では必須）"

  validation {
    condition     = var.domain_name != ""
    error_message = "本番では独自ドメインが必須です（TLS 1.2 以上のため）。"
  }
}

variable "acm_certificate_arn" {
  type        = string
  description = "独自ドメインの ACM 証明書（us-east-1）"
}

variable "alert_email" {
  type        = string
  description = "アラームの通知先（未決事項 6）"
  default     = ""
}

# 本番は、ステージングで作った GitHub の OIDC プロバイダーを使う
variable "create_oidc_provider" {
  type    = bool
  default = false
}
