variable "name" {
  description = "リソース名の接頭辞。メトリクスの次元 Environment にも使う（アプリの APP_ENV と同じ値）"
  type        = string
}

variable "ready_url" {
  description = "合成監視が叩く URL（CloudFront 経由の /api/../ready ではなく、公開の準備の確認先）"
  type        = string
}

variable "alert_email" {
  description = "通知先のメールアドレス。空なら購読を作らない（未決事項 6）"
  type        = string
  default     = ""
}

variable "latency_p95_threshold_ms" {
  description = "API の p95 の上限（5 分）。NF-O4"
  type        = number
  default     = 1000
}

variable "server_errors_threshold" {
  description = "5 分あたりの 5xx の件数の上限"
  type        = number
  default     = 5
}
