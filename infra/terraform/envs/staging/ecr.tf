// One repository for both environments, like the main app's wealthquest/quest.
// It lives here because staging is applied first; production looks it up.

resource "aws_ecr_repository" "app" {
  name = var.ecr_repository

  // Mutable because staging rolls by moving :latest. Production never uses
  // :latest - it pins a :<sha> tag in envs/production.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Drop untagged layers after a week"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        // Generous enough that any image production still pins is kept.
        rulePriority = 2
        description  = "Keep the newest 50 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 50
        }
        action = { type = "expire" }
      },
    ]
  })
}

// CI pulls its base images (node, buildkit) through this account's ECR instead
// of anonymously from public.ecr.aws: GitHub's shared runner IPs get
// `429 Too Many Requests` there. The first pull of a tag creates the cached
// repository ecr-public/<upstream path>; later pulls are served from ECR.
//
// Account-wide, keyed by prefix. Any project in the account may use it.
resource "aws_ecr_pull_through_cache_rule" "ecr_public" {
  ecr_repository_prefix = "ecr-public"
  upstream_registry_url = "public.ecr.aws"
}
