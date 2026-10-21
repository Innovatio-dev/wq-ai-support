variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type    = string
  default = "wayne"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "name_prefix" {
  type    = string
  default = "wq-prod-ai-support"
}

variable "hostname" {
  type    = string
  default = "help.wealthquest.com"
}

// The main app this service is embedded in.
variable "main_app_url" {
  type    = string
  default = "https://app.wealthquest.com"
}

// The main app's own production resources, joined or attached to, never managed.
variable "alb_name" {
  type    = string
  default = "wq-prod-alb"
}

variable "cluster_name" {
  type    = string
  default = "wealth-quest-production"
}

variable "private_subnet_name_pattern" {
  type    = string
  default = "wq-prod-private-*"
}

// wealthquest.com, owned by this account.
variable "route53_zone_id" {
  type    = string
  default = "Z0610154IZWX51J0LSY2"
}

// Clear of the main app's edge module, which uses 100 + n.
variable "listener_priority" {
  type    = number
  default = 500
}

variable "ecr_repository" {
  type    = string
  default = "wealthquest/ai-support"
}

// Production's own floating tag, as in the main app: the deploy workflow builds
// :production-<sha> and moves :production onto it only after the tests pass,
// then forces a new deployment. Never :latest - that is staging's tag and moves
// on every push to main.
variable "app_image_tag" {
  type    = string
  default = "production"

  validation {
    condition     = var.app_image_tag != "latest"
    error_message = ":latest belongs to staging."
  }
}

// TODO: replace with the figure agreed for production before the first apply.
variable "daily_budget_usd" {
  type    = number
  default = 5
}

// Each must exist as a SecureString at /wq-ai-support/production/<NAME> before
// planning. A missing one fails the plan here, not as a task that never starts.
variable "app_secret_names" {
  type    = list(string)
  default = ["OPENROUTER_API_KEY", "SESSION_SECRET", "AI_SUPPORT_SERVICE_SECRET"]
}

variable "log_retention_days" {
  type    = number
  default = 14
}
