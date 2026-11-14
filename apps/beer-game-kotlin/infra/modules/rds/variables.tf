variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "task_security_group_id" { type = string }

variable "engine_major" {
  type        = string
  default     = "18"
  description = "PostgreSQL のメジャー版（設計書: 18。RDS の標準サポートは 2031-02-28 まで。beer-game2 の確認値で、本書では再確認していない）"
}

variable "instance_class" {
  type        = string
  default     = "db.t4g.small"
  description = "設計書のコストの節の値。接続数の上限との整合は負荷試験で確認（初期案）"
}

variable "allocated_storage" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "beer_game_kotlin"
}

variable "master_username" {
  type        = string
  default     = "beergame_owner"
  description = "所有者（マイグレーションの接続のユーザー）。RDS の予約語（admin など）を避ける"
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "skip_final_snapshot" {
  type    = bool
  default = true
}
