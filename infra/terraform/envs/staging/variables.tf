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
  default = "staging"
}

variable "name_prefix" {
  type    = string
  default = "wq-ai-support"
}

variable "hostname" {
  type    = string
  default = "help-staging.wealthquest.com"
}

// The main app instance this one is embedded in. On staging that is the
// onboarding instance (app-staging.wealthquest.com), NOT the back office at
// bo.infinite-loop.pro: only a wealthquest.com host can frame help-staging
// with first-party cookies.
variable "main_app_url" {
  type    = string
  default = "https://app-staging.wealthquest.com"
}

// The main app's own staging resources, joined or attached to, never managed.
variable "alb_name" {
  type    = string
  default = "wq-alb"
}

variable "cluster_name" {
  type    = string
  default = "wealth-quest"
}

variable "private_subnet_name_pattern" {
  type    = string
  default = "wq-private-*"
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

// Staging follows the main app: CI pushes :<sha>, then moves :latest onto it and
// forces a new deployment. Production pins an immutable tag instead.
variable "app_image_tag" {
  type    = string
  default = "latest"
}

variable "daily_budget_usd" {
  type    = number
  default = 5
}

// Each must exist as a SecureString at /wq-ai-support/staging/<NAME> before
// planning. A missing one fails the plan here, not as a task that never starts.
variable "app_secret_names" {
  type    = list(string)
  default = ["OPENROUTER_API_KEY", "SESSION_SECRET", "AI_SUPPORT_SERVICE_SECRET"]
}

// The OIDC subject prefix of the repo whose GitHub Actions may assume the
// deploy role (github-deploy.tf). Immutable form: survives a rename, and a
// different repo later created under the same name cannot match it.
variable "github_oidc_sub_prefix" {
  type    = string
  default = "repo:Innovatio-dev@137341951/wq-ai-support@1425925557"
}

variable "log_retention_days" {
  type    = number
  default = 14
}
