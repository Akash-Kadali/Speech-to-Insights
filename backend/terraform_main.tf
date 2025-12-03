# backend/terraform_main.tf
#
# Core infra for speech_to_insights.
# - Creates or references S3 buckets for inputs, transform outputs, and logs.
# - Creates a Lambda IAM role (unless an external role ARN is supplied).
# - Emits helpful outputs for downstream modules or CI.
#
# This is intentionally conservative: heavy resources like SageMaker endpoints are left
# to specialized modules or created outside of this simple main. Toggle creation via variables.

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# random suffix used when auto-creating bucket names
resource "random_id" "suffix" {
  byte_length = 4
}

# Consolidated locals for names and tags
locals {
  input_bucket_name = (
    var.s3_input_bucket != null && var.s3_input_bucket != "" ?
    var.s3_input_bucket :
    "${var.project_name}-${var.environment}-inputs-${random_id.suffix.hex}"
  )

  transform_output_bucket_name = (
    var.s3_transform_output_bucket != null && var.s3_transform_output_bucket != "" ?
    var.s3_transform_output_bucket :
    "${var.project_name}-${var.environment}-transform-${random_id.suffix.hex}"
  )

  logs_bucket_name = (
    var.s3_logs_bucket != null && var.s3_logs_bucket != "" ?
    var.s3_logs_bucket :
    "${var.project_name}-${var.environment}-logs-${random_id.suffix.hex}"
  )

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
    },
    var.tags
  )

  # final computed role ARN: prefer provided var, otherwise created role
  effective_lambda_role_arn = var.lambda_role_arn != null ? var.lambda_role_arn : null

  # effective sagemaker transform role ARN (prefer user-provided)
  effective_sagemaker_transform_role_arn = var.sagemaker_transform_role_arn != null ? var.sagemaker_transform_role_arn : null
}

# -------------------
# S3 Buckets
# -------------------

resource "aws_s3_bucket" "input_bucket" {
  bucket = local.input_bucket_name
  acl    = "private"

  tags = local.common_tags

  lifecycle_rule {
    id      = "keep-very-long"
    enabled = true
    expiration {
      days = 3650
    }
  }

  versioning {
    enabled = false
  }
}

resource "aws_s3_bucket" "transform_output_bucket" {
  bucket = local.transform_output_bucket_name
  acl    = "private"

  tags = local.common_tags

  versioning {
    enabled = false
  }
}

resource "aws_s3_bucket" "logs_bucket" {
  bucket = local.logs_bucket_name
  acl    = "private"

  tags = local.common_tags

  lifecycle_rule {
    enabled = true
    expiration {
      days = 3650
    }
  }
}

# Optional server-side encryption configuration.
# If kms_key_id is null we prefer AES256 (S3 default); if kms_key_id provided, use AWS KMS.
resource "aws_s3_bucket_server_side_encryption_configuration" "input" {
  bucket = aws_s3_bucket.input_bucket.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_id != null ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_id != null ? var.kms_key_id : null
    }
  }

  lifecycle {
    ignore_changes = [rule]
  }

  depends_on = [aws_s3_bucket.input_bucket]
}

# -------------------
# IAM Role for Lambda (create only if lambda_role_arn not provided)
# -------------------

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "lambda_role" {
  count = var.lambda_role_arn == null ? 1 : 0

  name = "${var.project_name}-${var.environment}-lambda-role-${random_id.suffix.hex}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = ["lambda.amazonaws.com"]
        }
      }
    ]
  })

  tags = local.common_tags
}

data "aws_iam_policy_document" "lambda_policy" {
  statement {
    sid       = "s3Access"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"]
    resources = [
      aws_s3_bucket.input_bucket.arn,
      "${aws_s3_bucket.input_bucket.arn}/*",
      aws_s3_bucket.transform_output_bucket.arn,
      "${aws_s3_bucket.transform_output_bucket.arn}/*",
      aws_s3_bucket.logs_bucket.arn,
      "${aws_s3_bucket.logs_bucket.arn}/*",
    ]
  }

  statement {
    sid     = "cloudwatchLogs"
    effect  = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams"
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/*"]
  }

  # Conservative SageMaker permissions (broad - tighten for production)
  statement {
    sid     = "sagemaker"
    effect  = "Allow"
    actions = [
      "sagemaker:CreateTransformJob",
      "sagemaker:DescribeTransformJob",
      "sagemaker:CreateModel",
      "sagemaker:DescribeModel",
      "sagemaker:InvokeEndpoint",
      "sagemaker:DescribeEndpoint",
      "sagemaker:CreateEndpointConfig",
      "sagemaker:CreateEndpoint"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda_inline_policy" {
  count = var.lambda_role_arn == null ? 1 : 0

  name   = "${var.project_name}-${var.environment}-lambda-policy"
  role   = aws_iam_role.lambda_role[count.index].id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

# Update effective lambda role arn local if we created a role
# (we must use a dynamic mechanism; use a small null_resource to set output via outputs below)
# Instead, compute now via terraform expression in output below.

# -------------------
# SageMaker transform role (create if not provided)
# -------------------

resource "aws_iam_role" "sagemaker_transform_role" {
  count = var.sagemaker_transform_role_arn == null ? 1 : 0

  name = "${var.project_name}-${var.environment}-sagemaker-transform-role-${random_id.suffix.hex}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = ["sagemaker.amazonaws.com"]
        }
      }
    ]
  })

  tags = local.common_tags
}

data "aws_iam_policy_document" "sagemaker_policy" {
  statement {
    sid     = "s3AccessForSageMaker"
    effect  = "Allow"
    actions = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.transform_output_bucket.arn,
      "${aws_s3_bucket.transform_output_bucket.arn}/*",
      aws_s3_bucket.input_bucket.arn,
      "${aws_s3_bucket.input_bucket.arn}/*"
    ]
  }

  statement {
    sid     = "logs"
    effect  = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/sagemaker/*"]
  }
}

resource "aws_iam_role_policy" "sagemaker_inline_policy" {
  count = var.sagemaker_transform_role_arn == null ? 1 : 0

  name   = "${var.project_name}-${var.environment}-sagemaker-policy"
  role   = aws_iam_role.sagemaker_transform_role[count.index].id
  policy = data.aws_iam_policy_document.sagemaker_policy.json
}

# -------------------
# Outputs
# -------------------

output "input_s3_bucket" {
  description = "S3 bucket for audio inputs (name)."
  value       = aws_s3_bucket.input_bucket.bucket
}

output "transform_output_s3_bucket" {
  description = "S3 bucket used by transforms / model outputs (name)."
  value       = aws_s3_bucket.transform_output_bucket.bucket
}

output "logs_s3_bucket" {
  description = "S3 bucket used for logs and diagnostics (name)."
  value       = aws_s3_bucket.logs_bucket.bucket
}

output "lambda_role_arn" {
  description = "Lambda execution role ARN (either provided by var or created here)."
  value = var.lambda_role_arn != null ? var.lambda_role_arn :
    (length(aws_iam_role.lambda_role) > 0 ? aws_iam_role.lambda_role[0].arn : null)
}

output "sagemaker_transform_role_arn" {
  description = "SageMaker transform role ARN (provided or created)."
  value = var.sagemaker_transform_role_arn != null ? var.sagemaker_transform_role_arn :
    (length(aws_iam_role.sagemaker_transform_role) > 0 ? aws_iam_role.sagemaker_transform_role[0].arn : null)
}

output "region" {
  description = "AWS region used for this deployment."
  value       = var.aws_region
}

# -------------------
# Notes / guidance (not resources)
# - For SageMaker model endpoint creation, provide a dedicated module that consumes:
#   - model artifacts S3 path
#   - container image URI
#   - sagemaker transform role arn (above)
# - Package & deploy Lambda function code via CI:
#   - build a zip, upload to S3, then create aws_lambda_function resource referencing S3 key,
#   - or use a separate terraform module that supports local archive_file and zip deployment.
# - This main.tf intentionally avoids creating heavy resources (SageMaker endpoints, OpenSearch).
#   Add focused modules for those when ready and wire outputs/inputs between modules.
# -------------------
