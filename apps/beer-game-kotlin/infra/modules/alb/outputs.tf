output "dns_name" { value = aws_lb.this.dns_name }
output "security_group_id" { value = aws_security_group.alb.id }
output "target_group_arn" { value = aws_lb_target_group.api.arn }
output "alternate_target_group_arn" { value = aws_lb_target_group.api_alternate.arn }
output "alternate_target_group_arn_suffix" { value = aws_lb_target_group.api_alternate.arn_suffix }
output "production_listener_rule_arn" { value = aws_lb_listener_rule.from_cloudfront_only.arn }
output "arn_suffix" { value = aws_lb.this.arn_suffix }
output "target_group_arn_suffix" { value = aws_lb_target_group.api.arn_suffix }
