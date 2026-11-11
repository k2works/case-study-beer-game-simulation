terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # 状態は環境ごとに分けた、暗号化した S3 とロック（DynamoDB）に置く。
  # 値は init 時に渡す: terraform init -backend-config=backend.hcl（backend.hcl.example を参照）
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "beer-game2"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
