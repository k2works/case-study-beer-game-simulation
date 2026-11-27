output "critical_topic_arn" { value = aws_sns_topic.critical.arn }
output "warning_topic_arn" { value = aws_sns_topic.warning.arn }
output "dashboard_name" { value = aws_cloudwatch_dashboard.this.dashboard_name }
output "canary_name" { value = aws_synthetics_canary.ready.name }
