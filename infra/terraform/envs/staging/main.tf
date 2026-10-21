// Staging: help-staging.wealthquest.com on the main app's staging load balancer
// (wq-alb) and in its staging cluster (wealth-quest).

data "aws_vpc" "default" {
  default = true
}

// The main app's private subnets (its modules/network), found by name so this
// root never needs read access to the main app's state - which holds secrets.
data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "tag:Name"
    values = [var.private_subnet_name_pattern]
  }

  lifecycle {
    postcondition {
      condition     = length(self.ids) >= 2
      error_message = "Expected the main app's private subnets (${var.private_subnet_name_pattern}) in two AZs."
    }
  }
}

// Only the ARNs; the values reach the container through the ECS agent.
data "aws_ssm_parameter" "app" {
  for_each = toset(var.app_secret_names)

  name            = "/wq-ai-support/${var.environment}/${each.value}"
  with_decryption = false
}

module "service" {
  source = "../../modules/service"

  name_prefix = var.name_prefix
  aws_region  = var.aws_region

  alb_name          = var.alb_name
  hostname          = var.hostname
  route53_zone_id   = var.route53_zone_id
  listener_priority = var.listener_priority

  vpc_id             = data.aws_vpc.default.id
  private_subnet_ids = data.aws_subnets.private.ids
  cluster_name       = var.cluster_name

  app_image          = "${aws_ecr_repository.app.repository_url}:${var.app_image_tag}"
  log_retention_days = var.log_retention_days

  // See docs/DEPLOY.md for what each one does.
  app_environment = {
    NODE_ENV                   = "production"
    PORT                       = "3000"
    DEMO_MODE                  = "0"
    MOCK_OPENAI                = "0"
    OPENROUTER_APP_URL         = "https://${var.hostname}"
    OPENROUTER_APP_NAME        = "WealthQuest Support (staging)"
    OPENROUTER_DATA_COLLECTION = "deny"
    OPENROUTER_ZDR             = "0"
    DAILY_BUDGET_USD           = tostring(var.daily_budget_usd)
    ALLOWED_PARENT_ORIGINS     = var.main_app_url
    MAIN_APP_URL               = var.main_app_url
    // Must equal the main app's issuer exactly: its SSO_ISSUER, else its APP_URL.
    WQ_ISSUER = var.main_app_url
  }

  app_secrets = { for k, p in data.aws_ssm_parameter.app : k => p.arn }
}
