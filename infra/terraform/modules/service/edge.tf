// This service's slice of the main app's load balancer: a certificate on the
// HTTPS listener, a host-header rule, a target group, DNS, and the security
// groups between the ALB and the task.
//
// Everything here is a standalone resource that ATTACHES to the main app's ALB
// (aws_lb_listener_rule, aws_lb_listener_certificate, a single egress rule), so
// the main app's own plan never sees a diff because of it.

data "aws_lb" "main" {
  name = var.alb_name
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.main.arn
  port              = 443
}

locals {
  // `one()` fails the plan if the ALB ever gains a second group, rather than
  // silently opening the wrong one.
  alb_security_group_id = one(data.aws_lb.main.security_groups)
}

// ---------- security groups ----------

// Its own group rather than the main app's ECS group: that one is allowed into
// the database, and this service has no business there.
resource "aws_security_group" "task" {
  name        = "${var.name_prefix}-ecs"
  description = "AI support tasks - ALB ingress only, egress via NAT"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name_prefix}-ecs" }
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = local.alb_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  description                  = "From the load balancer"
}

// Outbound to OpenRouter and the main app (JWKS, /internal/ai/tickets), through the NAT.
resource "aws_vpc_security_group_egress_rule" "task_all" {
  security_group_id = aws_security_group.task.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound via NAT"
}

// The main app's ALB group only allows egress to its own tasks. This one rule,
// on THEIR group, lets the ALB reach ours. It is a separate resource, so it
// coexists with the main app's rules without either state fighting over them.
resource "aws_vpc_security_group_egress_rule" "alb_to_task" {
  security_group_id            = local.alb_security_group_id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  description                  = "To ${var.name_prefix} tasks"
}

// ---------- target group + host rule ----------

resource "aws_lb_target_group" "app" {
  name     = "${var.name_prefix}-tg"
  port     = var.container_port
  protocol = "HTTP"
  vpc_id   = var.vpc_id

  target_type          = "ip"
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  // There is only ever one task, but during a rolling deploy the old and new
  // tasks overlap for a minute. Conversations live in memory, so a browser that
  // bounced between them would lose its conversation mid-chat. Stickiness keeps
  // each browser on the task it started with.
  stickiness {
    type            = "lb_cookie"
    enabled         = true
    cookie_duration = 86400
  }

  tags = { Name = "${var.name_prefix}-tg" }
}

resource "aws_lb_listener_rule" "app" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = var.listener_priority

  condition {
    host_header {
      values = [var.hostname]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  tags = { Name = "${var.name_prefix}-host" }
}

// ---------- certificate + DNS ----------

resource "aws_acm_certificate" "app" {
  domain_name       = var.hostname
  validation_method = "DNS"

  lifecycle {
    // The listener holds this certificate; a replacement must be attached
    // before the old one is released.
    create_before_destroy = true
  }

  tags = { Name = var.hostname }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for o in aws_acm_certificate.app.domain_validation_options : o.domain_name => o
  }

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

// SNI: the listener keeps the main app's certificate as its default and serves
// this one for `hostname`.
resource "aws_lb_listener_certificate" "app" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.app.certificate_arn
}

resource "aws_route53_record" "app" {
  zone_id = var.route53_zone_id
  name    = var.hostname
  type    = "A"

  alias {
    name                   = data.aws_lb.main.dns_name
    zone_id                = data.aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
