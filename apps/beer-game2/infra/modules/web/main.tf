# 配信: CloudFront の単一オリジン構成。
#   既定  → S3（静的ファイル。OAC、非公開）
#   /api/* → ALB（キャッシュなし。Cookie と、Origin・If-Match・Idempotency-Key などのヘッダーをそのまま転送）
# ステージングは CloudFront の既定のドメイン。独自ドメインと ACM は B12。
resource "aws_s3_bucket" "web" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = var.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# セキュリティヘッダー（CSP、HSTS、nosniff、Referrer-Policy）
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.name}-security"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'self'"
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "same-origin"
      override        = true
    }
  }
}

locals {
  s3_origin  = "web"
  api_origin = "api"
  # AWS のマネージドポリシー
  cache_disabled         = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  cache_optimized        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  all_viewer_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_200"
  comment             = var.name

  origin {
    origin_id                = local.s3_origin
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
    # 配信する版。パイプラインが releases/<SHA> からここへ反映する（ロールバックは前の版を反映し直す）
    origin_path = "/current"
  }

  origin {
    origin_id   = local.api_origin
    domain_name = var.alb_dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # SSE の接続を維持する（アプリは 15 秒ごとにコメントを送る）。既定の上限は 60 秒
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }

    # ALB は、この合言葉のヘッダーが無い要求を 403 にする
    custom_header {
      name  = "X-Origin-Verify"
      value = var.origin_verify_value
    }
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = local.api_origin
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false
    cache_policy_id            = local.cache_disabled
    origin_request_policy_id   = local.all_viewer_except_host
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # SPA: 存在しないパス（S3 は 403 を返す）は index.html を返し、ルーターに任せる
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1"
  }
}

# CloudFront（このディストリビューション）だけが S3 を読める
data "aws_iam_policy_document" "bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.bucket.json
}
