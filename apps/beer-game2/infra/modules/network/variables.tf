variable "name" {
  type        = string
  description = "名前の接頭辞（例: beer-game2-staging）"
}

variable "cidr_block" {
  type    = string
  default = "10.20.0.0/16"
}
