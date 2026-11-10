# ALB: CloudFront からのみ到達できる。ヘルスチェックは /ready（DB 接続を確認）。
# ステージングは HTTP（独自ドメインと ACM は B12）。CloudFront が付ける合言葉のヘッダーが無い要求は 403 にする。
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "ALB: CloudFront のオリジン向けアドレスからのみ"
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "from_cloudfront" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  prefix_list_ids   = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  protocol          = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_security_group_rule" "to_tasks" {
  type                     = "egress"
  security_group_id        = aws_security_group.alb.id
  source_security_group_id = var.task_security_group_id
  protocol                 = "tcp"
  from_port                = var.container_port
  to_port                  = var.container_port
}

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 120
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  # 古い接続を速やかに切り離す（SSE は再接続される）
  deregistration_delay = 30

  health_check {
    path                = "/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront_only" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [var.origin_verify_value]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
