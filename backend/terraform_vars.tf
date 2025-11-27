# backend/terraform_vars.tf
#
# Project-level Terraform variables for the speech_to_insights backend.
# Put environment-specific values in terraform.tfvars
# or supply them via CLI/CI. Defaults are intentionally conservative.
# Most defaults are null to force explicit opt-in for real deployments.

variable "project_name" {
  description = "Short project identifier used in resource names and tags."
  type        = string
  default     = "speech-to-insights"
}

variable "environment" {
  description = "Deployment environment name (eg. dev, staging, prod)."
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region to create resources in (eg. us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "AWS account id. If not set, modules may derive it from provider."
  type        = string
  default     = null
}

############################
# S3 / storage
############################
variable "s3_input_bucket" {
  description = "S3 bucket for uploading audio inputs (batch transforms, uploads)."
  type        = string
  default     = null
}

variable "s3_transform_output_bucket" {
  description = "S3 bucket or bucket/prefix for model output artifacts."
  type        = string
  default     = null
}

variable "s3_logs_bucket" {
  description = "Optional S3 bucket for logs and diagnostics."
  type        = string
  default     = null
}

############################
# SageMaker / Model
############################
variable "sagemaker_model_name" {
  description = "Name of the SageMaker model (for transform jobs or endpoints)."
  type        = string
  default     = "whisper-model"
}

variable "sagemaker_endpoint_name" {
  description = "Realtime SageMaker endpoint name. Leave null to skip creating one."
  type        = string
  default     = null
}

variable "sagemaker_instance_type" {
  description = "Instance type for realtime or transform jobs (eg. ml.g4dn.xlarge)."
  type        = string
  default     = "ml.g4dn.xlarge"
}

variable "sagemaker_instance_count" {
  description = "Instance count for SageMaker transforms / endpoints."
  type        = number
  default     = 1
}

variable "sagemaker_transform_role_arn" {
  description = "IAM role ARN that SageMaker assumes for transform jobs."
  type        = string
  default     = null
}

############################
# Lambda / compute
############################
variable "lambda_memory_mb" {
  description = "Default Lambda memory size."
  type        = number
  default     = 2048
}

variable "lambda_timeout_sec" {
  description = "Default Lambda timeout (seconds)."
  type        = number
  default     = 300
}

variable "lambda_role_arn" {
  description = "IAM role ARN for Lambda. If null, Terraform may create one."
  type        = string
  default     = null
}

variable "lambda_reserved_concurrent_executions" {
  description = "Optional reserved concurrency for Lambdas."
  type        = number
  default     = null
}

############################
# Step Functions / Orchestration
############################
variable "step_functions_role_arn" {
  description = "IAM role ARN for Step Functions state machines."
  type        = string
  default     = null
}

############################
# Networking (optional)
############################
variable "vpc_id" {
  description = "VPC id for deploying compute resources. Optional."
  type        = string
  default     = null
}

variable "subnet_ids" {
  description = "Subnets for resources needing VPC access."
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "Security groups for VPC-resident resources."
  type        = list(string)
  default     = []
}

############################
# KMS / encryption
############################
variable "kms_key_id" {
  description = "Optional KMS key arn/id used for S3 or other encrypted resources."
  type        = string
  default     = null
}

############################
# CI / deployment
############################
variable "ci_deploy_user" {
  description = "Optional IAM user/role used by CI to deploy infra."
  type        = string
  default     = null
}

variable "enable_ci_workflow" {
  description = "Enable or disable CI/CD workflow resources."
  type        = bool
  default     = false
}

############################
# Misc / feature flags
############################
variable "create_sagemaker_endpoint" {
  description = "Whether to create a SageMaker realtime endpoint."
  type        = bool
  default     = false
}

variable "enable_step_functions" {
  description = "Whether to create Step Functions orchestration resources."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Default resource tags."
  type        = map(string)
  default = {
    Project     = "speech-to-insights"
    Environment = "dev"
  }
}

############################
# Testing / local dev
############################
variable "local_development" {
  description = "Controls behavior for local dev (skip expensive resources)."
  type        = bool
  default     = true
}

variable "allow_destroy_production" {
  description = "Safety flag: allow Terraform destroy in production environments."
  type        = bool
  default     = false
}

############################
# Example overrides (DO NOT COMMIT)
############################
# aws_region = "us-west-2"
# environment = "prod"
# s3_input_bucket = "my-speech-inputs-prod"
# s3_transform_output_bucket = "my-speech-outputs-prod/prefix"
# sagemaker_transform_role_arn = "arn:aws:iam::123456789012:role/SageMakerTransformRole"
# lambda_role_arn = "arn:aws:iam::123456789012:role/LambdaExecutionRole"
