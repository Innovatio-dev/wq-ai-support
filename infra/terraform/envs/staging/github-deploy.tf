// The GitHub Actions deploy role for this repo (.github/workflows/deploy.yml).
//
// Its own role rather than the main app's `wealth-quest-github-deploy`: that
// one trusts only Innovatio-dev/wealth-quest and is not in Terraform. A role
// per repo keeps each one's grants to its own services - this one can push to
// wealthquest/ai-support and restart the two AI support services, nothing else.
//
// Account-level, shared by both environments, so it lives in this root only
// (the same reason the main app keeps its deploy policy in envs/staging).

data "aws_caller_identity" "current" {}

// Already exists in the account (the main app's deploy role uses it).
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  account_id = data.aws_caller_identity.current.account_id

  // Production's service is created by envs/production, so its ARN is built
  // from the names there rather than read from that state.
  deploy_service_arns = [
    module.service.ecs_service_arn,
    "arn:aws:ecs:${var.aws_region}:${local.account_id}:service/wealth-quest-production/wq-prod-ai-support-app",
  ]
}

data "aws_iam_policy_document" "github_deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    // Only jobs that run in one of this repo's GitHub environments - which is
    // where branch rules and production reviewers are enforced.
    //
    // This repo uses GitHub's immutable OIDC subject, which carries the owner
    // and repo IDs ("repo:Innovatio-dev@137341951/wq-ai-support@1425925557:...").
    // The main app's repo still uses the plain "repo:Innovatio-dev/wealth-quest"
    // form, so its trust policy is not a template for this one. Check with
    // `gh api repos/<repo>/actions/oidc/customization/sub` (sub_claim_prefix).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "${var.github_oidc_sub_prefix}:environment:staging",
        "${var.github_oidc_sub_prefix}:environment:production",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "wq-ai-support-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_trust.json
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  // Push the build, and re-tag it (promote-image.sh: BatchGetImage + PutImage).
  statement {
    sid = "EcrPushPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  // Base images through the pull-through cache (ecr.tf). CreateRepository and
  // BatchImportUpstreamImage are what let the first pull of a new tag populate it.
  statement {
    sid = "EcrPullThroughCache"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:CreateRepository",
      "ecr:BatchImportUpstreamImage",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${local.account_id}:repository/${aws_ecr_pull_through_cache_rule.ecr_public.ecr_repository_prefix}/*"]
  }

  // CI never authors a task definition; it only restarts the service onto the
  // freshly promoted tag. CPU, memory and environment are Terraform changes.
  statement {
    sid       = "EcsRollService"
    actions   = ["ecs:UpdateService"]
    resources = local.deploy_service_arns
  }

  statement {
    sid       = "EcsReadServiceStatus"
    actions   = ["ecs:DescribeServices"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "wq-ai-support-github-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
