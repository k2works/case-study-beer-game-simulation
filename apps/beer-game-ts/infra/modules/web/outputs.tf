output "bucket_name" { value = aws_s3_bucket.web.bucket }
output "bucket_arn" { value = aws_s3_bucket.web.arn }
output "distribution_id" { value = aws_cloudfront_distribution.this.id }
output "distribution_arn" { value = aws_cloudfront_distribution.this.arn }
output "domain_name" { value = aws_cloudfront_distribution.this.domain_name }
output "public_domain" {
  description = "利用者が開くドメイン（独自ドメインがあればそれ、無ければ CloudFront の既定）"
  value       = var.domain_name != "" ? var.domain_name : aws_cloudfront_distribution.this.domain_name
}
