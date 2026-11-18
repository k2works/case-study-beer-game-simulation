output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = aws_ecs_service.api.name }
output "service_arn" { value = aws_ecs_service.api.id }
output "api_task_family" { value = aws_ecs_task_definition.api.family }
output "migrate_task_family" { value = aws_ecs_task_definition.migrate.family }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "execution_role_arn" { value = aws_iam_role.execution.arn }

output "retention_task_family" { value = aws_ecs_task_definition.batch["retention"].family }
output "verify_projections_task_family" { value = aws_ecs_task_definition.batch["verify-projections"].family }
output "rebuild_projections_task_family" { value = aws_ecs_task_definition.batch["rebuild-projections"].family }
output "cluster_arn" { value = aws_ecs_cluster.this.arn }

output "log_group_arns" {
  value = [
    aws_cloudwatch_log_group.api.arn,
    aws_cloudwatch_log_group.migrate.arn,
    aws_cloudwatch_log_group.retention.arn,
    aws_cloudwatch_log_group.verify_projections.arn,
    aws_cloudwatch_log_group.rebuild_projections.arn,
  ]
}
