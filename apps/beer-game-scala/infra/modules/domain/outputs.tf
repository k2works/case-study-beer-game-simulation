output "certificate_arn" {
  description = "検証が済んだ証明書の ARN（CloudFront の viewer_certificate に渡す）"
  value       = aws_acm_certificate_validation.this.certificate_arn
}
