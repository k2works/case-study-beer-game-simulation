variable "name" { type = string }
variable "bucket_name" { type = string }
variable "alb_dns_name" { type = string }

variable "origin_verify_value" {
  type      = string
  sensitive = true
}

variable "force_destroy" {
  type        = bool
  default     = false
  description = "ステージングの片付けで、中身ごと消してよいか"
}

variable "domain_name" {
  type        = string
  default     = ""
  description = "独自ドメイン（例: beer.example.jp）。空なら CloudFront の既定のドメイン（TLS の最低版を指定できない）"
}

variable "acm_certificate_arn" {
  type        = string
  default     = ""
  description = "独自ドメインの ACM 証明書（us-east-1 で発行）。domain_name を指定するときは必須"

  validation {
    condition     = var.acm_certificate_arn == "" || startswith(var.acm_certificate_arn, "arn:aws:acm:us-east-1:")
    error_message = "CloudFront の証明書は us-east-1 の ACM で発行してください。"
  }
}
