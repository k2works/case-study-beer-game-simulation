variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "github_repository" {
  type        = string
  description = "GitHub の owner/repo（OIDC の信頼の条件に使う）"
}

variable "image" {
  type        = string
  description = "初期のイメージ（ステージングで検証したダイジェスト。<ECR の URL>@sha256:...）。以降はパイプラインが差し替える"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "イメージはダイジェスト固定（<ECR の URL>@sha256:<64 桁の 16 進>）で指定してください。"
  }
}

variable "web_bucket_name" {
  type        = string
  description = "静的ファイルのバケット名（全世界で一意）"
}

variable "domain_name" {
  type        = string
  description = "独自ドメイン（設計書の未決事項。本番では必須）"

  validation {
    condition     = var.domain_name != ""
    error_message = "本番では独自ドメインが必須です（TLS 1.2 以上のため）。"
  }
}

variable "hosted_zone_id" {
  type        = string
  description = "独自ドメインの Route 53 のホストゾーン ID（証明書の DNS 検証と、CloudFront への別名を置く。すでにある前提）"
}

variable "critical_alarm_emails" {
  type        = list(string)
  default     = []
  description = "重大のアラームの通知先（メール）。適用後に、購読の確認のメールを承認する"
}

variable "warning_alarm_emails" {
  type        = list(string)
  default     = []
  description = "警告のアラームの通知先（メール）"
}

# 本番は、ステージングで作った GitHub の OIDC プロバイダーを使う（同じアカウントの場合）
variable "create_oidc_provider" {
  type    = bool
  default = false
}
