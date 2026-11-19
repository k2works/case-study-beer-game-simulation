# 独自ドメイン（B14）: ACM の証明書（DNS 検証）と、Route 53 の別名レコード（CloudFront へ）。
# CloudFront の証明書は us-east-1 で発行する（プロバイダーの別名 aws.us_east_1 を、呼び出し側が渡す）。
# ホストゾーンは、すでにある前提（ドメインの取得・委任は人が行う。AWS では未確認）。
terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

resource "aws_acm_certificate" "this" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for option in aws_acm_certificate.this.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

# CloudFront の別名（A と AAAA）。Z2FDTNDATAQYW2 は、CloudFront のエイリアスの固定のホストゾーン ID
resource "aws_route53_record" "alias" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name                   = var.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}
