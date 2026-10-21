provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  # Shared account: tag everything so this service is identifiable and billable
  # on its own, and grouped with the rest of wealth-quest.
  default_tags {
    tags = {
      Project     = "wealth-quest"
      Service     = "ai-support"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
