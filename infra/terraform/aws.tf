provider "aws" {
  region = var.aws_default_region
}

# Regional AWS provider configurations for the 13 probe regions
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

provider "aws" {
  alias  = "us_east_2"
  region = "us-east-2"
}

provider "aws" {
  alias  = "us_west_2"
  region = "us-west-2"
}

provider "aws" {
  alias  = "eu_west_1"
  region = "eu-west-1"
}

provider "aws" {
  alias  = "eu_central_1"
  region = "eu-central-1"
}

provider "aws" {
  alias  = "ap_northeast_1"
  region = "ap-northeast-1"
}

provider "aws" {
  alias  = "ap_northeast_2"
  region = "ap-northeast-2"
}

provider "aws" {
  alias  = "ap_southeast_1"
  region = "ap-southeast-1"
}

provider "aws" {
  alias  = "ap_southeast_2"
  region = "ap-southeast-2"
}

provider "aws" {
  alias  = "ap_south_1"
  region = "ap-south-1"
}

provider "aws" {
  alias  = "sa_east_1"
  region = "sa-east-1"
}

provider "aws" {
  alias  = "af_south_1"
  region = "af-south-1"
}

provider "aws" {
  alias  = "me_central_1"
  region = "me-central-1"
}

# IAM OIDC Provider for GitHub Actions (Pipeline identity)
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

import {
  to = aws_iam_openid_connect_provider.github
  id = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
}

# IAM Role: cloudping-deployer
resource "aws_iam_role" "cloudping_deployer" {
  name = "cloudping-deployer"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = var.aws_oidc_subject
          }
        }
      }
    ]
  })
}

import {
  to = aws_iam_role.cloudping_deployer
  id = "cloudping-deployer"
}

# IAM Role Policy: cloudping-deployer inline policy
resource "aws_iam_role_policy" "cloudping_deployer" {
  name = "cloudping-lambda-deploy-policy"
  role = aws_iam_role.cloudping_deployer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "LambdaDeploy"
        Effect = "Allow"
        Action = [
          "lambda:UpdateFunctionCode",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration"
        ]
        Resource = [
          for r in var.aws_probe_regions : "arn:aws:lambda:${r}:${var.aws_account_id}:function:cloudping-probe"
        ]
      }
    ]
  })
}

import {
  to = aws_iam_role_policy.cloudping_deployer
  id = "cloudping-deployer:cloudping-lambda-deploy-policy"
}

# IAM Role: cloudping-probe-invoker
resource "aws_iam_role" "cloudping_probe_invoker" {
  name        = "cloudping-probe-invoker"
  description = "GitHub Actions OIDC role to invoke cloudping-probe Lambdas in US/EU/SG"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = var.aws_oidc_subject
          }
        }
      }
    ]
  })
}

import {
  to = aws_iam_role.cloudping_probe_invoker
  id = "cloudping-probe-invoker"
}

# IAM Role Policy: cloudping-probe-invoker inline policy
resource "aws_iam_role_policy" "cloudping_probe_invoker" {
  name = "InvokeProbeLambdas"
  role = aws_iam_role.cloudping_probe_invoker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "lambda:InvokeFunction"
        Resource = [
          for r in var.aws_probe_regions : "arn:aws:lambda:${r}:${var.aws_account_id}:function:cloudping-probe"
          if r != "ap-northeast-2"
        ]
      }
    ]
  })
}

import {
  to = aws_iam_role_policy.cloudping_probe_invoker
  id = "cloudping-probe-invoker:InvokeProbeLambdas"
}

# IAM Role: cloudping-probe-lambda (Execution role for all Lambdas)
resource "aws_iam_role" "cloudping_probe_lambda" {
  name = "cloudping-probe-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

import {
  to = aws_iam_role.cloudping_probe_lambda
  id = "cloudping-probe-lambda"
}

# IAM Role Policy Attachment: AWSLambdaBasicExecutionRole
resource "aws_iam_role_policy_attachment" "cloudping_probe_lambda_basic" {
  role       = aws_iam_role.cloudping_probe_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

import {
  to = aws_iam_role_policy_attachment.cloudping_probe_lambda_basic
  id = "cloudping-probe-lambda/arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# -----------------------------------------------------------------------------
# Clock Lambda & EventBridge in ap-northeast-2
# -----------------------------------------------------------------------------
resource "aws_lambda_function" "clock" {
  function_name = "cloudping-probe-clock"
  runtime       = "nodejs24.x"
  role          = aws_iam_role.cloudping_probe_lambda.arn
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 128
  timeout       = 10
  description   = "30-minute EventBridge clock: workflow_dispatch Probe"
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      GITHUB_DISPATCH_TOKEN = var.github_dispatch_token
      GITHUB_REPO           = var.github_repo
      GITHUB_REF            = "main"
      GITHUB_WORKFLOW       = "probe.yml"
    }
  }

  lifecycle {
    ignore_changes = [
      filename,
      image_uri,
      s3_bucket,
      s3_key,
      s3_object_version,
      source_code_hash
    ]
  }
}

import {
  to = aws_lambda_function.clock
  id = "cloudping-probe-clock"
}

resource "aws_cloudwatch_event_rule" "clock" {
  name                = "cloudping-probe-clock"
  schedule_expression = "rate(30 minutes)"
  state               = "ENABLED"
}

import {
  to = aws_cloudwatch_event_rule.clock
  id = "cloudping-probe-clock"
}

resource "aws_cloudwatch_event_target" "clock" {
  rule      = aws_cloudwatch_event_rule.clock.name
  target_id = "clock"
  arn       = aws_lambda_function.clock.arn
}

import {
  to = aws_cloudwatch_event_target.clock
  id = "cloudping-probe-clock/clock"
}

resource "aws_lambda_permission" "clock_eventbridge" {
  statement_id  = "EventBridgeClock"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.clock.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.clock.arn
}

import {
  to = aws_lambda_permission.clock_eventbridge
  id = "cloudping-probe-clock/EventBridgeClock"
}

# -----------------------------------------------------------------------------
# Regional Probe Lambdas (13 regions)
# -----------------------------------------------------------------------------

# 1. us-east-1
resource "aws_lambda_function" "probe_us_east_1" {
  provider      = aws.us_east_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-us-east-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (us-east-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.us_east_1
  to       = aws_lambda_function.probe_us_east_1
  id       = "cloudping-probe"
}

# 2. us-east-2 (has Function URL)
resource "aws_lambda_function" "probe_us_east_2" {
  provider      = aws.us_east_2
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-us-east-2"
      PROBE_ORIGIN_LABEL = "AWS Lambda (us-east-2)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.us_east_2
  to       = aws_lambda_function.probe_us_east_2
  id       = "cloudping-probe"
}

resource "aws_lambda_function_url" "probe_us_east_2" {
  provider           = aws.us_east_2
  function_name      = aws_lambda_function.probe_us_east_2.function_name
  authorization_type = "NONE"
}

import {
  provider = aws.us_east_2
  to       = aws_lambda_function_url.probe_us_east_2
  id       = "cloudping-probe"
}

resource "aws_lambda_permission" "probe_url_us_east_2" {
  provider               = aws.us_east_2
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.probe_us_east_2.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

import {
  provider = aws.us_east_2
  to       = aws_lambda_permission.probe_url_us_east_2
  id       = "cloudping-probe/FunctionURLAllowPublicAccess"
}

# 3. us-west-2
resource "aws_lambda_function" "probe_us_west_2" {
  provider      = aws.us_west_2
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-us-west-2"
      PROBE_ORIGIN_LABEL = "AWS Lambda (us-west-2)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.us_west_2
  to       = aws_lambda_function.probe_us_west_2
  id       = "cloudping-probe"
}

# 4. eu-west-1 (has Function URL)
resource "aws_lambda_function" "probe_eu_west_1" {
  provider      = aws.eu_west_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-eu-west-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (eu-west-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.eu_west_1
  to       = aws_lambda_function.probe_eu_west_1
  id       = "cloudping-probe"
}

resource "aws_lambda_function_url" "probe_eu_west_1" {
  provider           = aws.eu_west_1
  function_name      = aws_lambda_function.probe_eu_west_1.function_name
  authorization_type = "NONE"
}

import {
  provider = aws.eu_west_1
  to       = aws_lambda_function_url.probe_eu_west_1
  id       = "cloudping-probe"
}

resource "aws_lambda_permission" "probe_url_eu_west_1" {
  provider               = aws.eu_west_1
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.probe_eu_west_1.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

import {
  provider = aws.eu_west_1
  to       = aws_lambda_permission.probe_url_eu_west_1
  id       = "cloudping-probe/FunctionURLAllowPublicAccess"
}

# 5. eu-central-1
resource "aws_lambda_function" "probe_eu_central_1" {
  provider      = aws.eu_central_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-eu-central-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (eu-central-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.eu_central_1
  to       = aws_lambda_function.probe_eu_central_1
  id       = "cloudping-probe"
}

# 6. ap-northeast-1 (has Function URL)
resource "aws_lambda_function" "probe_ap_northeast_1" {
  provider      = aws.ap_northeast_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-ap-northeast-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (ap-northeast-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.ap_northeast_1
  to       = aws_lambda_function.probe_ap_northeast_1
  id       = "cloudping-probe"
}

resource "aws_lambda_function_url" "probe_ap_northeast_1" {
  provider           = aws.ap_northeast_1
  function_name      = aws_lambda_function.probe_ap_northeast_1.function_name
  authorization_type = "NONE"
}

import {
  provider = aws.ap_northeast_1
  to       = aws_lambda_function_url.probe_ap_northeast_1
  id       = "cloudping-probe"
}

resource "aws_lambda_permission" "probe_url_ap_northeast_1" {
  provider               = aws.ap_northeast_1
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.probe_ap_northeast_1.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

import {
  provider = aws.ap_northeast_1
  to       = aws_lambda_permission.probe_url_ap_northeast_1
  id       = "cloudping-probe/FunctionURLAllowPublicAccess"
}

# 7. ap-northeast-2 (has Function URL)
resource "aws_lambda_function" "probe_ap_northeast_2" {
  provider                       = aws.ap_northeast_2
  function_name                  = "cloudping-probe"
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  memory_size                    = 512
  timeout                        = 300
  role                           = aws_iam_role.cloudping_probe_lambda.arn
  reserved_concurrent_executions = 2
  filename                       = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-ap-northeast-2"
      PROBE_ORIGIN_LABEL = "AWS Lambda (ap-northeast-2)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.ap_northeast_2
  to       = aws_lambda_function.probe_ap_northeast_2
  id       = "cloudping-probe"
}

resource "aws_lambda_function_url" "probe_ap_northeast_2" {
  provider           = aws.ap_northeast_2
  function_name      = aws_lambda_function.probe_ap_northeast_2.function_name
  authorization_type = "NONE"
}

import {
  provider = aws.ap_northeast_2
  to       = aws_lambda_function_url.probe_ap_northeast_2
  id       = "cloudping-probe"
}

resource "aws_lambda_permission" "probe_url_ap_northeast_2" {
  provider               = aws.ap_northeast_2
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.probe_ap_northeast_2.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

import {
  provider = aws.ap_northeast_2
  to       = aws_lambda_permission.probe_url_ap_northeast_2
  id       = "cloudping-probe/FunctionURLAllowPublicAccess"
}

# 8. ap-southeast-1
resource "aws_lambda_function" "probe_ap_southeast_1" {
  provider      = aws.ap_southeast_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-ap-southeast-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (ap-southeast-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.ap_southeast_1
  to       = aws_lambda_function.probe_ap_southeast_1
  id       = "cloudping-probe"
}

# 9. ap-southeast-2
resource "aws_lambda_function" "probe_ap_southeast_2" {
  provider      = aws.ap_southeast_2
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-ap-southeast-2"
      PROBE_ORIGIN_LABEL = "AWS Lambda (ap-southeast-2)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.ap_southeast_2
  to       = aws_lambda_function.probe_ap_southeast_2
  id       = "cloudping-probe"
}

# 10. ap-south-1
resource "aws_lambda_function" "probe_ap_south_1" {
  provider      = aws.ap_south_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-ap-south-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (ap-south-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.ap_south_1
  to       = aws_lambda_function.probe_ap_south_1
  id       = "cloudping-probe"
}

# 11. sa-east-1
resource "aws_lambda_function" "probe_sa_east_1" {
  provider      = aws.sa_east_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-sa-east-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (sa-east-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.sa_east_1
  to       = aws_lambda_function.probe_sa_east_1
  id       = "cloudping-probe"
}

# 12. af-south-1
resource "aws_lambda_function" "probe_af_south_1" {
  provider      = aws.af_south_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-af-south-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (af-south-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.af_south_1
  to       = aws_lambda_function.probe_af_south_1
  id       = "cloudping-probe"
}

# 13. me-central-1
resource "aws_lambda_function" "probe_me_central_1" {
  provider      = aws.me_central_1
  function_name = "cloudping-probe"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  timeout       = 300
  role          = aws_iam_role.cloudping_probe_lambda.arn
  filename      = "${path.module}/dummy.zip"

  environment {
    variables = {
      PROBE_ORIGIN_ID    = "aws-me-central-1"
      PROBE_ORIGIN_LABEL = "AWS Lambda (me-central-1)"
      PROBE_SECRET       = var.probe_secret
    }
  }

  lifecycle {
    ignore_changes = [filename, image_uri, s3_bucket, s3_key, s3_object_version, source_code_hash]
  }
}

import {
  provider = aws.me_central_1
  to       = aws_lambda_function.probe_me_central_1
  id       = "cloudping-probe"
}
