# wq-ai-support infrastructure (Terraform)

The AI support service on AWS, next to the main app. Same conventions as
`wealth-quest/infra/terraform`: one root per environment, the shared state bucket,
the `wayne` profile, secrets in SSM, immutable image tags in production.

| | Staging | Production |
|---|---|---|
| URL | `https://help-staging.wealthquest.com` | `https://help.wealthquest.com` |
| Embedded in | `https://app-staging.wealthquest.com` | `https://app.wealthquest.com` |
| Load balancer | `wq-alb` | `wq-prod-alb` |
| ECS cluster | `wealth-quest` | `wealth-quest-production` |
| Image | `wealthquest/ai-support:latest` | `wealthquest/ai-support:production` |
| State key | `ai-support/staging/terraform.tfstate` | `ai-support/production/terraform.tfstate` |

## What this manages, and what it only attaches to

The main app's Terraform owns the VPC, private subnets, NAT, load balancers,
clusters and the `wealthquest.com` zone. This repo **looks them up by name** (never
through the main app's state, which holds secrets) and adds only its own pieces:

- an ECS service (one task, on-demand Fargate) with its task definition, log group and roles;
- its own task security group, plus **one egress rule on the main app's ALB group** so the ALB can reach it;
- a target group, a host-header rule (priority 500; the main app uses 100+n) and an ACM certificate attached to the HTTPS listener;
- the Route53 alias and the certificate's validation record;
- the ECR repository `wealthquest/ai-support` and the GitHub deploy role
  `wq-ai-support-github-deploy` (both in `envs/staging`, shared by both environments).

These are all standalone resources, so the main app's `terraform plan` stays clean.

**Exactly one task.** Conversations, rate limits and the daily budget are in memory
([docs/DEPLOY.md](../../docs/DEPLOY.md)). Hence no autoscaling and no Fargate Spot,
even in staging. The target group is sticky so the brief old/new overlap during a
rolling deploy doesn't move a browser between tasks.

## Secrets (once per environment, before `plan`)

SecureStrings at `/wq-ai-support/<env>/<NAME>`. The plan fails if one is missing.

| Name | Value |
|---|---|
| `OPENROUTER_API_KEY` | One key per environment, with a credit limit set in OpenRouter. |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `AI_SUPPORT_SERVICE_SECRET` | `openssl rand -hex 32`; the **same value** goes into the main app's environment. |

```bash
MSYS_NO_PATHCONV=1 aws --profile wayne --region us-east-1 ssm put-parameter \
  --type SecureString --name /wq-ai-support/staging/SESSION_SECRET --value "$(openssl rand -hex 32)"
```

(`MSYS_NO_PATHCONV=1` stops Git Bash on Windows from rewriting the leading `/` into a path.)

## Usage

```bash
cd infra/terraform/envs/staging
terraform init
terraform plan
terraform apply

cd ../production
terraform plan
```

## Deploys

[`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml), the same shape as the main app's:
the image is built under an immutable tag while the tests run, then the environment's
floating tag is moved onto it and the service is forced onto it.

| | Trigger | Built as | Runs as |
|---|---|---|---|
| Staging | every push to `main` | `:<sha>` | `:latest` |
| Production | manual dispatch, type `production` to confirm | `:production-<sha>` | `:production` |

Auth is GitHub OIDC into `wq-ai-support-github-deploy` (`envs/staging/github-deploy.tf`),
which trusts only jobs in this repo's `staging` and `production` GitHub environments and
can only push to this ECR repository and restart these two services. Each GitHub
environment holds the variables listed at the top of the workflow.

### First apply in an environment

The service needs an image before its task can start:

1. Staging only: `terraform apply -target=aws_ecr_repository.app -target=aws_ecr_lifecycle_policy.app`.
2. Get the environment's run tag into ECR: the deploy workflow, or once by hand with
   `docker build --platform linux/amd64`. Production's first `:production` needs the
   workflow's build + promote steps; its roll step fails until step 3 has run, which is expected.
3. `terraform apply` for everything else.

## The main app's side

- `AI_SUPPORT_ORIGIN` = this service's URL and `AI_SUPPORT_SERVICE_SECRET` = the same value as above.
- The ALBs' WAF (geo allow-list, rate limits) now covers `help.*` as well.
