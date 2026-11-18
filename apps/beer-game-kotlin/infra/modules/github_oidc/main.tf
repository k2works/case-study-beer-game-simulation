# GitHub Actions が、長期のアクセスキー無しで AWS を引き受けるための OIDC。
# デプロイ用ロールの権限は最小（アプリのデプロイだけ）。インフラの変更（terraform apply）は含めない。
# 信頼は「このリポジトリの、この GitHub Environment」だけ。Step 3 のワークフローは environment: を指定すること。
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
  # サービスの更新と参照は、この環境の API サービスだけ
  statement {
    sid       = "EcsService"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [var.ecs_service_arn]
  }
  # タスク定義の登録・参照と、タスクの実行・参照は、リソースを絞れない（または絞りにくい）
  statement {
    sid = "EcsTasks"
    actions = [
      "ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition",
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
  # 本番のデプロイ前の手動スナップショット（B14。マイグレーション前の復元点）。この環境のインスタンスと、その名前のスナップショットだけ
  dynamic "statement" {
    for_each = var.snapshot_instance_arn == "" ? [] : [1]
    content {
      sid     = "PreDeploySnapshot"
      actions = ["rds:CreateDBSnapshot", "rds:DeleteDBSnapshot"]
      resources = [
        var.snapshot_instance_arn,
        "${replace(var.snapshot_instance_arn, ":db:", ":snapshot:")}-pre-*",
      ]
    }
  }
  dynamic "statement" {
    for_each = var.snapshot_instance_arn == "" ? [] : [1]
    content {
      sid       = "DescribeSnapshots"
      actions   = ["rds:DescribeDBSnapshots"]
      resources = ["*"]
    }
  }
  # マイグレーションのタスクのログの確認だけ（この環境のロググループ）
  statement {
    sid       = "ReadLogs"
    actions   = ["logs:GetLogEvents", "logs:DescribeLogStreams"]
    resources = flatten([for arn in var.log_group_arns : [arn, "${arn}:*"]])
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
