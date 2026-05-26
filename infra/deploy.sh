#!/usr/bin/env bash
# BCC Connect — one-shot Azure deployment.
# See DEPLOY.md for prereqs (Entra app registration, GitHub repo, az login).
#
# Required env vars:
#   SUBSCRIPTION_ID, RESOURCE_GROUP, REPO_URL, REPO_TOKEN,
#   ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET
# Optional:
#   LOCATION (default centralus), BRANCH (default main),
#   BCC_TENANT_ID (default blue-collar-coach), ENABLE_COSMOS_FREE_TIER (default true)

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${SUBSCRIPTION_ID:?SUBSCRIPTION_ID is required}"
: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${REPO_URL:?REPO_URL is required}"
: "${REPO_TOKEN:?REPO_TOKEN is required}"
: "${ENTRA_TENANT_ID:?ENTRA_TENANT_ID is required}"
: "${ENTRA_CLIENT_ID:?ENTRA_CLIENT_ID is required}"
: "${ENTRA_CLIENT_SECRET:?ENTRA_CLIENT_SECRET is required}"
LOCATION="${LOCATION:-centralus}"
BRANCH="${BRANCH:-main}"
BCC_TENANT_ID="${BCC_TENANT_ID:-blue-collar-coach}"
ENABLE_COSMOS_FREE_TIER="${ENABLE_COSMOS_FREE_TIER:-true}"

echo "==> Subscription: $SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID" >/dev/null

echo "==> Ensure resource group: $RESOURCE_GROUP in $LOCATION"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" >/dev/null

deployment_name="bcc-deploy-$(date +%Y%m%d%H%M%S)"
echo "==> Deploying: $deployment_name"

az deployment group create \
  --name "$deployment_name" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$script_dir/main.bicep" \
  --parameters \
    appName=bcc-connect \
    swaLocation="$LOCATION" \
    enableCosmosFreeTier="$ENABLE_COSMOS_FREE_TIER" \
    repositoryUrl="$REPO_URL" \
    branch="$BRANCH" \
    repositoryToken="$REPO_TOKEN" \
    entraTenantId="$ENTRA_TENANT_ID" \
    entraClientId="$ENTRA_CLIENT_ID" \
    entraClientSecret="$ENTRA_CLIENT_SECRET" \
    bccTenantId ="$BCC_TENANT_ID" \
  --output table

echo
echo "==> Outputs"
az deployment group show --resource-group "$RESOURCE_GROUP" --name "$deployment_name" \
  --query properties.outputs --output yaml

hostname=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name "$deployment_name" \
  --query 'properties.outputs.swaDefaultHostname.value' -o tsv)
echo
echo "Done. App URL: https://$hostname"
echo "Next: in the Azure portal, open the Static Web App > Role management"
echo "      and invite yourself with the 'administrator' role so /admin.html works."
