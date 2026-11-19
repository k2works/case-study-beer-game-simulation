output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = aws_ecs_service.api.name }
output "api_task_family" { value = aws_ecs_task_definition.api.family }
output "migrate_task_family" { value = aws_ecs_task_definition.migrate.family }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "execution_role_arn" { value = aws_iam_role.execution.arn }
