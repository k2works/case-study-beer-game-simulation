variable "name" { type = string }

variable "keep_images" {
  type        = number
  default     = 30
  description = "残すイメージの数（ロールバックの候補）"
}
