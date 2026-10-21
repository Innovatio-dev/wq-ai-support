terraform {
  # >= 1.10 required: the S3 backend's native `use_lockfile` (see backend.tf).
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
