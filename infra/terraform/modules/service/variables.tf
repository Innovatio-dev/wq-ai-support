variable "name_prefix" { type = string }
variable "aws_region" { type = string }

// The main app's load balancer, looked up by name. This module adds a host rule,
// a certificate and one security-group rule to it; it never modifies the ALB or
// its listener resources, which the main app's Terraform owns.
variable "alb_name" { type = string }

// Exactly one hostname, e.g. help.wealthquest.com. It must sit under the same
// parent domain as the main app, or the iframe's cookies become third-party.
variable "hostname" { type = string }

// The Route53 zone that holds `hostname`. Terraform writes the ACM validation
// record and the alias itself, so renewal is hands-off.
variable "route53_zone_id" { type = string }

// The main app's edge module uses 100 + n for its own additional hostnames.
// Stay well clear of that range so neither side ever renumbers the other.
variable "listener_priority" { type = number }

variable "vpc_id" { type = string }

// The main app's private subnets: tasks get no public IP and leave through the
// environment's NAT, so outbound calls come from its known Elastic IP. That is
// also what makes `trust proxy = 1` in server.js safe - the ALB is the only way in.
variable "private_subnet_ids" { type = list(string) }

// The cluster is joined, never created: it belongs to the main app.
variable "cluster_name" { type = string }

variable "app_image" { type = string }

variable "container_port" {
  type    = number
  default = 3000
}

variable "health_check_path" {
  type    = string
  default = "/healthz"
}

variable "task_cpu" {
  type    = number
  default = 256
}

variable "task_memory" {
  type    = number
  default = 512
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "enable_execute_command" {
  type    = bool
  default = false
}

variable "app_environment" {
  type    = map(string)
  default = {}
}

// NAME => SSM parameter ARN. Resolved by the ECS agent at task start with the
// execution role; values never pass through Terraform or its state.
variable "app_secrets" {
  type    = map(string)
  default = {}
}
