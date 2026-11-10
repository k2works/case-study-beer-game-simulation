variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "github_repository" {
  type    = string
  default = "k2works/case-study-beer-game-simulation"
}

variable "image" {
  type        = string
  description = "初期のイメージ（<ECR の URL>@sha256:... のダイジェスト固定）。以降はパイプラインが差し替える"
}

variable "web_bucket_name" {
  type        = string
  description = "静的ファイルのバケット名（全世界で一意）"
}

variable "create_oidc_provider" {
  type    = bool
  default = true
}
