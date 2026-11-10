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
