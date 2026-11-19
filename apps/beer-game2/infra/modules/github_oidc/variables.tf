variable "name" { type = string }

variable "github_repository" {
  type        = string
  description = "owner/repo"
}

variable "environment" {
  type        = string
  description = "GitHub Environment の名前（staging など）"
}

variable "create_provider" {
  type        = bool
  default     = true
  description = "アカウントに OIDC プロバイダーが既にあれば false"
}

variable "ecr_repository_arn" { type = string }
variable "web_bucket_arn" { type = string }
variable "distribution_arn" { type = string }
variable "pass_role_arns" { type = list(string) }
