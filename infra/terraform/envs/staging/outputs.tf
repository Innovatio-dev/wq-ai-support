output "url" { value = module.service.url }
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "ecs_cluster_name" { value = module.service.ecs_cluster_name }
output "app_log_group" { value = module.service.app_log_group }

output "ecs_service_name" { value = module.service.ecs_service_name }
output "ecs_service_arn" { value = module.service.ecs_service_arn }
output "ecr_repository_arn" { value = aws_ecr_repository.app.arn }

// The AWS_DEPLOY_ROLE_ARN variable of both GitHub environments.
output "github_deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
