variable "name" { type = string }

variable "database_url" {
  type      = string
  sensitive = true
}

variable "recovery_window_in_days" {
  type        = number
  default     = 7
  description = "削除後の復旧期間。ステージングは短くしてよい"
}
