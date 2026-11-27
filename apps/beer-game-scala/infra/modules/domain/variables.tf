variable "domain_name" {
  type        = string
  description = "利用者が開く独自ドメイン（ホストゾーンの中のドメイン）"
}

variable "hosted_zone_id" {
  type        = string
  description = "Route 53 のホストゾーン ID（DNS 検証と別名のレコードを置く）"
}

variable "cloudfront_domain_name" {
  type        = string
  description = "別名の向け先の CloudFront のドメイン（xxxx.cloudfront.net）"
}
