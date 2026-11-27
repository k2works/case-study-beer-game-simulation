# ALB: CloudFront からのみ到達できる。ヘルスチェックは /api/v1/ready（DB 接続とスキーマの版を確認）。
# HTTP のリスナー（独自ドメインと ACM の本設定は B14）。CloudFront が付ける合言葉のヘッダーが無い要求は 403 にする。
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
  idle_timeout               = 60 # 設計書: アイドルタイムアウト 60 秒（SSE は 15 秒ごとの心拍で維持）
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  # 古い接続を速やかに切り離す（SSE は再接続される）。アプリの終了の猶予（ECS の stopTimeout）と整合させる
  deregistration_delay = var.deregistration_delay

  health_check {
    path                = var.health_check_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# ブルー/グリーン用のもう一方の対象グループ（B14）。名前は 32 文字の上限に収める（本番の name は 27 文字）。
# 本番のブルー/グリーンのとき、ECS が api とこのグループを交互に使う（切り替えのたびに、リスナールールの転送先が変わる）。
# ステージング（ローリング）では、空のまま置く。
resource "aws_lb_target_group" "api_alternate" {
  name        = "${var.name}-api2"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  deregistration_delay = var.deregistration_delay

  health_check {
    path                = var.health_check_path
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

  # ブルー/グリーンの切り替えで、ECS が転送先を書き換える。Terraform は差分として扱わない
  lifecycle {
    ignore_changes = [action]
  }
}
