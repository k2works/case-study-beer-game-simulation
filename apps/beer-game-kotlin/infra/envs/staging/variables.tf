variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "github_repository" {
  type        = string
  description = "GitHub の owner/repo（OIDC の信頼の条件に使う）"
}

variable "image" {
  type        = string
  description = "初期のイメージ（<ECR の URL>@sha256:... のダイジェスト固定）。以降はパイプラインが差し替える"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "イメージはダイジェスト固定（<ECR の URL>@sha256:<64 桁の 16 進>）で指定してください。"
  }
}

variable "web_bucket_name" {
  type        = string
  description = "静的ファイルのバケット名（全世界で一意）"
}

variable "create_oidc_provider" {
  type        = bool
  default     = true
  description = "アカウントに GitHub の OIDC プロバイダーが既にあれば false"
}
