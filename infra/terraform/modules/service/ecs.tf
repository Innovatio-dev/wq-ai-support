// The service itself: one task, on-demand Fargate, in the main app's cluster.
//
// Exactly one task, always. Conversations, rate limits and the daily AI budget
// are held in memory (docs/DEPLOY.md), so a second task would split them. That
// is why there is no autoscaling and no Fargate Spot here even in staging: a
// Spot reclamation wipes every open conversation and resets the budget.

locals {
  container_env = [
    for k, v in var.app_environment : { name = k, value = v }
  ]

  container_secrets = [
    for k, v in var.app_secrets : { name = k, valueFrom = v }
  ]

  // Rendered only when non-empty, so an environment without secrets does not
  // carry an empty `secrets: []` key (same convention as the main app).
  container_secrets_fragment = length(var.app_secrets) > 0 ? { secrets = local.container_secrets } : {}
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/ecs/${var.name_prefix}-app"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.name_prefix}-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    merge({
      name        = "Main"
      image       = var.app_image
      essential   = true
      environment = local.container_env
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]
    }, local.container_secrets_fragment)
  ])
}

resource "aws_ecs_service" "app" {
  name            = "${var.name_prefix}-app"
  cluster         = var.cluster_name
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "Main"
    container_port   = var.container_port
  }

  // Rolling: the new task starts before the old one stops, so a deploy has no
  // gap. The overlap is the one moment two tasks exist; target-group stickiness
  // (edge.tf) keeps each browser on one of them.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  // Boot loads and validates both knowledge bases before listening; a few
  // seconds, but give the first health checks room.
  health_check_grace_period_seconds = 60

  enable_execute_command = var.enable_execute_command

  // ECS registers targets only into a target group that a listener forwards to.
  depends_on = [aws_lb_listener_rule.app]
}
