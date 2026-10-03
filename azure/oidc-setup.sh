#!/usr/bin/env bash
# One-time (idempotent) bootstrap for GitHub Actions -> Azure OIDC deploy auth.
# Creates an Azure AD app registration + federated credential (no client
# secret) trusted only for pushes to main on cloudpickr/cloudping.me, and grants
# it "Website Contributor" scoped to the cloudping-probe resource group only
# (can deploy code to the 11 existing F1 apps, cannot create/delete plans or
# apps, cannot touch anything outside that resource group).
#
# Prints the three values (client id / tenant id / subscription id) to set as
# GitHub Actions repository VARIABLES (not secrets -- none of these are
# sensitive on their own without the federated trust):
#   gh variable set AZURE_CLIENT_ID -b <clientId>
#   gh variable set AZURE_TENANT_ID -b <tenantId>
#   gh variable set AZURE_SUBSCRIPTION_ID -b <subscriptionId>
#
# Safe to re-run: every step checks for the resource first.
set -euo pipefail

APP_NAME="cloudping-github-deploy"
RG="cloudping-probe"
REPO_ID="cloudpickr/cloudping.me"
BRANCH="main"

# OIDC subject. As of GitHub's 2026-07-15 change, repos created/renamed/
# transferred use the immutable `sub` claim form
# repo:<owner>@<OWNER_ID>/<name>@<REPO_ID>:ref:refs/heads/<branch> rather than
# the slug-based form. Override OIDC_SUBJECT if the owner/repo IDs differ; look
# it up with:
#   gh api repos/${REPO_ID}/actions/oidc/customization/sub --jq .sub_claim_prefix
# (append ":ref:refs/heads/${BRANCH}"). The default below matches cloudpickr.
OIDC_SUBJECT="${OIDC_SUBJECT:-repo:cloudpickr@80160794/cloudping.me@1227660849:ref:refs/heads/${BRANCH}}"

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"

echo "=== AD app registration: ${APP_NAME} ==="
APP_ID="$(az ad app list --display-name "${APP_NAME}" --query '[0].appId' -o tsv)"
if [ -z "${APP_ID}" ]; then
  APP_ID="$(az ad app create --display-name "${APP_NAME}" --query appId -o tsv)"
  echo "created app ${APP_ID}"
else
  echo "exists app ${APP_ID}"
fi

echo ""
echo "=== Service principal ==="
if ! az ad sp show --id "${APP_ID}" >/dev/null 2>&1; then
  az ad sp create --id "${APP_ID}" >/dev/null
  echo "created service principal"
else
  echo "exists service principal"
fi

echo ""
echo "=== Federated credential (GitHub OIDC, main branch only) ==="
if ! az ad app federated-credential list --id "${APP_ID}" --query "[?name=='github-main']" -o tsv | grep -q .; then
  az ad app federated-credential create --id "${APP_ID}" --parameters "$(cat <<JSON
{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "${OIDC_SUBJECT}",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON
)" >/dev/null
  echo "created federated credential"
else
  echo "exists federated credential"
fi

echo ""
echo "=== Role assignment: Website Contributor on resource group ${RG} ==="
SCOPE="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RG}"
if ! az role assignment list --assignee "${APP_ID}" --scope "${SCOPE}" --query "[?roleDefinitionName=='Website Contributor']" -o tsv | grep -q .; then
  az role assignment create --assignee "${APP_ID}" --role "Website Contributor" --scope "${SCOPE}" >/dev/null
  echo "created role assignment"
else
  echo "exists role assignment"
fi

echo ""
echo "=== Done ==="
echo "AZURE_CLIENT_ID=${APP_ID}"
echo "AZURE_TENANT_ID=${TENANT_ID}"
echo "AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}"
