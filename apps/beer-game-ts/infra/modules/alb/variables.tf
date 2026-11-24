variable "name" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "task_security_group_id" { type = string }

variable "container_port" {
  type    = number
  default = 3000
}

variable "origin_verify_value" {
  type      = string
  sensitive = true
}
