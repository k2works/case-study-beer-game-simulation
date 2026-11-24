variable "name" {
  type        = string
  description = "名前の接頭辞（例: beer-game-ts-staging）"
}

variable "cidr_block" {
  type    = string
  default = "10.20.0.0/16"
}
