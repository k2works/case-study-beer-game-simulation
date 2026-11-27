terraform {
  # 設計書: Terraform 1.17 以上（beer-game2 の確認値の引き継ぎ）。1.17.2 は releases.hashicorp.com の一覧で実在を確認した
  required_version = ">= 1.17.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # 状態は環境ごとに分けた、暗号化した S3 に置く。ロックは S3 のロックファイル（use_lockfile）。
  # 値は init 時に渡す: terraform init -backend-config=backend.hcl（backend.hcl.example を参照）
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "beer-game-scala"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
