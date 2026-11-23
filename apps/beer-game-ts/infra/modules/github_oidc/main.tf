# GitHub Actions が、長期のアクセスキー無しで AWS を引き受けるための OIDC。
# デプロイ用ロールの権限は最小（アプリのデプロイだけ）。インフラの変更（terraform apply）は含めない。
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  provider_arn = var.create_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # このリポジトリの、この GitHub Environment からのみ
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages",
    ]
    resources = [var.ecr_repository_arn]
  }
  statement {
    sid = "EcsDeploy"
    actions = [
      "ecs:DescribeServices", "ecs:UpdateService", "ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition",
      "ecs:RunTask", "ecs:DescribeTasks", "ecs:ListTasks",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = var.pass_role_arns
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "WebBucket"
    actions   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [var.web_bucket_arn, "${var.web_bucket_arn}/*"]
  }
  statement {
    sid       = "Invalidate"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [var.distribution_arn]
  }
  statement {
    sid       = "ReadLogs"
    actions   = ["logs:GetLogEvents", "logs:DescribeLogStreams"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
