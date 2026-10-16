#!/usr/bin/env bash
# Deploy the cloudping probe Lambda to one or more AWS regions.
#
# Each region becomes an additional /health "From" column. The handler is
# region-agnostic: resolveOrigin() in src/fns/probe-server.ts derives the
# column id/label from AWS_REGION at runtime, but we also set PROBE_ORIGIN_ID/
# PROBE_ORIGIN_LABEL explicitly for clarity.
#
# Prereqs:
#   - AWS CLI authenticated (aws sts get-caller-identity)
#   - npx esbuild available
#   - PROBE_SECRET exported (same secret GitHub Actions sends as Bearer)
#   - An execution role usable across regions (IAM is global)
#
# Usage:
#   PROBE_SECRET=xxx ./lambda/deploy.sh us-east-1 eu-central-1 ap-southeast-1
#
# Prints each region's Function URL at the end — add them to the GitHub
# Actions PROBE_URLS secret (or PROBE_URL_* ) so the probe workflow wakes them.
set -euo pipefail

FUNCTION_NAME="cloudping-probe"
# Role ARN: pass ROLE_ARN to override. Otherwise derive it from the caller's
# account (via STS) so the account ID isn't hardcoded in this public repo.
LAMBDA_ROLE_NAME="${LAMBDA_ROLE_NAME:-cloudping-probe-lambda}"
if [ -z "${ROLE_ARN:-}" ]; then
  _acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"
  ROLE_ARN="arn:aws:iam::${_acct}:role/${LAMBDA_ROLE_NAME}"
fi
RUNTIME="nodejs24.x"
ARCH="arm64"
MEM="512"
TIMEOUT="300"
HANDLER="index.handler"

: "${PROBE_SECRET:?export PROBE_SECRET first}"
if [ "$#" -eq 0 ]; then
  echo "usage: PROBE_SECRET=xxx $0 <region> [region ...]" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "${build_dir}"' EXIT

echo "Bundling handler with esbuild..."
npx --yes esbuild "${repo_root}/lambda/handler.ts" \
  --bundle --platform=node --target=node24 --format=cjs \
  --alias:@app/data="${repo_root}/src/data" \
  --outfile="${build_dir}/index.js" >/dev/null

( cd "${build_dir}" && zip -qr function.zip index.js )
zip_path="${build_dir}/function.zip"
echo "Bundle: $(du -h "${zip_path}" | cut -f1)"

for region in "$@"; do
  origin_id="aws-${region}"
  origin_label="AWS Lambda (${region})"
  echo ""
  echo "=== ${region} ==="

  if aws lambda get-function --region "${region}" --function-name "${FUNCTION_NAME}" >/dev/null 2>&1; then
    echo "updating existing function code + config..."
    aws lambda update-function-code --region "${region}" --function-name "${FUNCTION_NAME}" \
      --zip-file "fileb://${zip_path}" --architectures "${ARCH}" >/dev/null
    aws lambda wait function-updated --region "${region}" --function-name "${FUNCTION_NAME}"
    aws lambda update-function-configuration --region "${region}" --function-name "${FUNCTION_NAME}" \
      --runtime "${RUNTIME}" --handler "${HANDLER}" --memory-size "${MEM}" --timeout "${TIMEOUT}" \
      --environment "Variables={PROBE_ORIGIN_ID=${origin_id},PROBE_ORIGIN_LABEL=${origin_label},PROBE_SECRET=${PROBE_SECRET}}" >/dev/null
  else
    echo "creating function..."
    aws lambda create-function --region "${region}" --function-name "${FUNCTION_NAME}" \
      --runtime "${RUNTIME}" --handler "${HANDLER}" --architectures "${ARCH}" \
      --role "${ROLE_ARN}" --memory-size "${MEM}" --timeout "${TIMEOUT}" \
      --zip-file "fileb://${zip_path}" \
      --environment "Variables={PROBE_ORIGIN_ID=${origin_id},PROBE_ORIGIN_LABEL=${origin_label},PROBE_SECRET=${PROBE_SECRET}}" >/dev/null
    aws lambda wait function-active --region "${region}" --function-name "${FUNCTION_NAME}"
  fi

  # Ensure a public Function URL exists (app-level Bearer auth via PROBE_SECRET).
  # Invoke-only regions (listed in NO_URL_REGIONS) are reached via `aws lambda invoke`
  # from GitHub Actions (OIDC role) and must NOT expose a public URL. Only regions
  # that genuinely need a Function URL (e.g. the EventBridge/PROBE_URL_* path) get one.
  # Set NO_URL_REGIONS to a space-separated list; defaults to the current invoke-only set.
  NO_URL_REGIONS="${NO_URL_REGIONS:-us-east-1 eu-central-1 ap-southeast-1 us-west-2 sa-east-1}"
  if printf '%s\n' ${NO_URL_REGIONS} | grep -qx "${region}"; then
    # Remove any stale URL/permission so re-running this script can't re-expose it.
    aws lambda delete-function-url-config --region "${region}" --function-name "${FUNCTION_NAME}" >/dev/null 2>&1 || true
    aws lambda remove-permission --region "${region}" --function-name "${FUNCTION_NAME}" \
      --statement-id FunctionURLAllowPublicAccess >/dev/null 2>&1 || true
    echo "Invoke-only (no Function URL)."
    continue
  fi
  if ! aws lambda get-function-url-config --region "${region}" --function-name "${FUNCTION_NAME}" >/dev/null 2>&1; then
    aws lambda create-function-url-config --region "${region}" --function-name "${FUNCTION_NAME}" \
      --auth-type NONE >/dev/null
    aws lambda add-permission --region "${region}" --function-name "${FUNCTION_NAME}" \
      --statement-id FunctionURLAllowPublicAccess --action lambda:InvokeFunctionUrl \
      --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true
  fi
  url="$(aws lambda get-function-url-config --region "${region}" --function-name "${FUNCTION_NAME}" --query FunctionUrl --output text)"
  echo "Function URL: ${url}"
done

echo ""
echo "Add these URLs to the GitHub Actions PROBE_URLS secret (newline-separated)."
