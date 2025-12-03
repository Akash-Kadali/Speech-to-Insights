#!/usr/bin/env bash
set -euo pipefail

# deploy_lambdas.sh
#
# Package and deploy backend Lambda functions from the repository.
# - Creates a zip of the SOURCE_DIR (default backend)
# - Uploads the zip to S3 (bucket/prefix)
# - For each named Lambda function, either creates it (if missing) or updates its code
# - Optionally updates environment variables and tags
#
# Usage examples:
#   ./deploy_lambdas.sh --bucket my-deploy-bucket --prefix lambda-artifacts --functions api_upload_handler,s3_event_handler --role-arn arn:aws:iam::123:role/myLambdaRole
#   ./deploy_lambdas.sh --help
#
# Requirements:
# - aws CLI configured with permissions to put objects to S3, create/update Lambda functions, and get functions
# - zip installed
# - jq required if using --handler-map JSON file
#
# Notes:
# - This script will not override an existing function's role or VPC config.
# - Provide ROLE_ARN for initial creation (create-function requires an execution role).
# - You may set PACKAGE_NAME and SOURCE_DIR env vars to change defaults.
#

# Defaults (can be overridden via env or CLI)
PACKAGE_NAME="${PACKAGE_NAME:-speech_to_insights_backend.zip}"
SOURCE_DIR="${SOURCE_DIR:-backend}"
S3_REGION="${S3_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
TAG_PROJECT="${TAG_PROJECT:-speech-to-insights}"
TMPDIR="${TMPDIR:-/tmp}"
FORCE_CREATE=false

print_help() {
  cat <<EOF
deploy_lambdas.sh - package & deploy Lambda functions

Required:
  --bucket BUCKET            S3 bucket to upload artifact to
  --prefix PREFIX            S3 prefix/folder for uploads

Optional:
  --functions F1,F2,...      Comma-separated list of lambda function names to deploy
  --role-arn ARN             IAM role ARN to use when creating a new Lambda function
  --handler-map FILE         Optional JSON file mapping function-name -> handler (jq required)
  --runtime RUNTIME          Lambda runtime (default: python310)
  --memory MB                Memory size for created functions (default: 2048)
  --timeout SEC              Timeout for created functions (default: 300)
  --env "KEY=VAL,KEY2=VAL2"  Comma separated env vars to set on create/update (update will replace)
  --force-create             Allow create without role_arn (not recommended)
  --source-dir DIR           Source directory to package (default: backend)
  --package-name NAME        Output zip name (default: speech_to_insights_backend.zip)
  --help

Examples:
  ./deploy_lambdas.sh --bucket my-bucket --prefix lambda-artifacts --functions api_upload_handler,s3_event_handler --role-arn arn:aws:iam::123:role/LambdaExecRole
EOF
}

# parse args
AWS_S3_BUCKET=""
S3_PREFIX=""
FUNCTIONS_CSV=""
ROLE_ARN=""
RUNTIME="python310"
MEMORY="2048"
TIMEOUT="300"
ENV_OVERRIDES=""
HANDLER_MAP_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) AWS_S3_BUCKET="$2"; shift 2 ;;
    --prefix) S3_PREFIX="$2"; shift 2 ;;
    --functions) FUNCTIONS_CSV="$2"; shift 2 ;;
    --role-arn) ROLE_ARN="$2"; shift 2 ;;
    --handler-map) HANDLER_MAP_FILE="$2"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --env) ENV_OVERRIDES="$2"; shift 2 ;;
    --force-create) FORCE_CREATE=true; shift 1 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --package-name) PACKAGE_NAME="$2"; shift 2 ;;
    --help) print_help; exit 0 ;;
    *) echo "Unknown arg: $1"; print_help; exit 1 ;;
  esac
done

if [[ -z "$AWS_S3_BUCKET" || -z "$S3_PREFIX" ]]; then
  echo "Error: --bucket and --prefix are required."
  print_help
  exit 2
fi

# prepare functions list
IFS=',' read -r -a FUNCTIONS_ARRAY <<< "$(echo "${FUNCTIONS_CSV}" | sed 's/ //g')"

# If no functions provided, try to read a default file listing or fallback
if [[ -z "$FUNCTIONS_CSV" ]]; then
  if [[ -f "${SOURCE_DIR}/lambdas.txt" ]]; then
    mapfile -t FUNCTIONS_ARRAY < <(sed 's/^\s*#.*$//g' "${SOURCE_DIR}/lambdas.txt" | sed '/^\s*$/d')
  else
    # sensible defaults based on repository
    FUNCTIONS_ARRAY=(api_upload_handler s3_event_handler start_transform_handler sagemaker_transform_callback health_handler)
  fi
fi

# helper to create env var JSON for aws cli (strict replacement)
_make_env_json() {
  local env_csv="$1"
  if [[ -z "$env_csv" ]]; then
    echo ""
    return
  fi
  IFS=',' read -r -a kvs <<< "$env_csv"
  local json="{\"Variables\":{"
  local first=true
  for kv in "${kvs[@]}"; do
    if [[ -z "$kv" ]]; then continue; fi
    key="${kv%%=*}"
    val="${kv#*=}"
    # escape quotes
    val_escaped="$(printf '%s' "$val" | sed 's/"/\\"/g')"
    if [[ "$first" = true ]]; then
      json="${json}\"${key}\":\"${val_escaped}\""
      first=false
    else
      json="${json},\"${key}\":\"${val_escaped}\""
    fi
  done
  json="${json}}}"
  echo "$json"
}

ENV_JSON=$(_make_env_json "${ENV_OVERRIDES}")

echo "Packaging ${SOURCE_DIR} -> ${PACKAGE_NAME}"
TMP_ZIP="${TMPDIR%/}/${PACKAGE_NAME}"
rm -f "${TMP_ZIP}"

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "Source directory ${SOURCE_DIR} does not exist."
  exit 3
fi

# create zip of the SOURCE_DIR contents, preserve relative paths
(
  set -x
  cd "${SOURCE_DIR}"
  # -q: quiet, -r: recurse, -y: store symbolic links as the link
  zip -qry "${TMP_ZIP}" .
  set +x
)

# Upload to S3
S3_KEY="${S3_PREFIX%/}/${PACKAGE_NAME}"
echo "Uploading artifact to s3://${AWS_S3_BUCKET}/${S3_KEY}"
aws s3 cp "${TMP_ZIP}" "s3://${AWS_S3_BUCKET}/${S3_KEY}" --region "${S3_REGION}"

# Default handler mapping: function_name -> "<module>.<handler>"
declare -A HANDLER_MAP
if [[ -n "${HANDLER_MAP_FILE}" && -f "${HANDLER_MAP_FILE}" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "handler-map requires jq to parse JSON. Install jq or omit --handler-map."
    exit 4
  fi
  while IFS="=" read -r k v; do
    HANDLER_MAP["$k"]="$v"
  done < <(jq -r "to_entries|map(\"\(.key)=\(.value|tostring)\")|.[]" "${HANDLER_MAP_FILE}")
else
  for fn in "${FUNCTIONS_ARRAY[@]}"; do
    case "$fn" in
      api_upload_handler) HANDLER_MAP["$fn"]="backend.lambda_handlers.api_upload_handler" ;;
      s3_event_handler) HANDLER_MAP["$fn"]="backend.lambda_handlers.s3_event_handler" ;;
      start_transform_handler) HANDLER_MAP["$fn"]="backend.lambda_handlers.start_transform_handler" ;;
      sagemaker_transform_callback) HANDLER_MAP["$fn"]="backend.lambda_handlers.sagemaker_transform_callback" ;;
      health_handler) HANDLER_MAP["$fn"]="backend.lambda_handlers.health_handler" ;;
      *) HANDLER_MAP["$fn"]="backend.lambda_handlers.${fn}" ;;
    esac
  done
fi

# iterate and deploy each function
for fn in "${FUNCTIONS_ARRAY[@]}"; do
  fn_trimmed="$(echo -n "$fn" | xargs)"  # trim
  if [[ -z "$fn_trimmed" ]]; then
    continue
  fi
  handler="${HANDLER_MAP[$fn_trimmed]:-backend.lambda_handlers.${fn_trimmed}}"
  echo "Processing function ${fn_trimmed} -> handler ${handler}"

  # check if function exists
  if aws lambda get-function --function-name "${fn_trimmed}" --region "${S3_REGION}" >/dev/null 2>&1; then
    echo "Function ${fn_trimmed} exists. Updating code..."
    aws lambda update-function-code \
      --function-name "${fn_trimmed}" \
      --s3-bucket "${AWS_S3_BUCKET}" \
      --s3-key "${S3_KEY}" \
      --publish \
      --region "${S3_REGION}" >/dev/null

    echo "Updating function configuration (memory/timeout/handler) for ${fn_trimmed}"
    # update configuration (this replaces environment with provided map if present)
    if [[ -n "${ENV_JSON}" ]]; then
      aws lambda update-function-configuration \
        --function-name "${fn_trimmed}" \
        --handler "${handler}" \
        --runtime "${RUNTIME}" \
        --memory-size "${MEMORY}" \
        --timeout "${TIMEOUT}" \
        --environment "${ENV_JSON}" \
        --region "${S3_REGION}" >/dev/null
    else
      aws lambda update-function-configuration \
        --function-name "${fn_trimmed}" \
        --handler "${handler}" \
        --runtime "${RUNTIME}" \
        --memory-size "${MEMORY}" \
        --timeout "${TIMEOUT}" \
        --region "${S3_REGION}" >/dev/null
    fi
    echo "Updated ${fn_trimmed} successfully."
  else
    echo "Function ${fn_trimmed} not found. Creating..."
    if [[ -z "${ROLE_ARN}" && "${FORCE_CREATE}" != "true" ]]; then
      echo "Role ARN is required to create a new Lambda. Provide --role-arn or use --force-create to bypass (not recommended). Skipping ${fn_trimmed}."
      continue
    fi

    # Create function; require ROLE_ARN unless force-create
    create_cmd=(aws lambda create-function
      --function-name "${fn_trimmed}"
      --runtime "${RUNTIME}"
      --handler "${handler}"
      --code "S3Bucket=${AWS_S3_BUCKET},S3Key=${S3_KEY}"
      --memory-size "${MEMORY}"
      --timeout "${TIMEOUT}"
      --publish
      --tags "Project=${TAG_PROJECT}"
      --region "${S3_REGION}"
    )
    if [[ -n "${ROLE_ARN}" ]]; then
      create_cmd+=(--role "${ROLE_ARN}")
    fi
    if [[ -n "${ENV_JSON}" ]]; then
      create_cmd+=(--environment "${ENV_JSON}")
    fi

    # Run create command
    "${create_cmd[@]}"
    echo "Created ${fn_trimmed}."
  fi

  # Optionally report published version
  latest_ver=$(aws lambda get-function-configuration --function-name "${fn_trimmed}" --region "${S3_REGION}" --query 'Version' --output text 2>/dev/null || echo "\$LATEST")
  if [[ "${latest_ver}" != "\$LATEST" ]]; then
    echo "Published version ${latest_ver} for ${fn_trimmed}"
  fi
done

echo "Deployment complete. Artifact s3://${AWS_S3_BUCKET}/${S3_KEY}"
