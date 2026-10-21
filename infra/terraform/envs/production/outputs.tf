output "url" { value = module.service.url }
output "ecs_cluster_name" { value = module.service.ecs_cluster_name }
output "app_log_group" { value = module.service.app_log_group }

// The deploy role (envs/staging/github-deploy.tf) builds this ARN from the same
// names; if they change here, change them there.
output "ecs_service_name" { value = module.service.ecs_service_name }
output "ecs_service_arn" { value = module.service.ecs_service_arn }
