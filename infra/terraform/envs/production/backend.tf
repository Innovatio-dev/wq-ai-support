// Same bucket as the main app (wealth-quest/infra/terraform), its own key, so
// nothing here can read or write the main app's state.
terraform {
  backend "s3" {
    bucket       = "wealth-quest-tfstate-156299069207"
    key          = "ai-support/production/terraform.tfstate"
    region       = "us-east-1"
    profile      = "wayne"
    encrypt      = true
    use_lockfile = true
  }
}
