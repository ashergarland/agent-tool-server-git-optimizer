#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT_NAME="${1:-dev}"
LOCATION="${2:-eastus}"
DEPLOYMENT_NAME="ats-${ENVIRONMENT_NAME}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
SECRET_NAME="tool-server-api-key"
BOOTSTRAP_PRINCIPAL_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv)"

# The tool server can analyze nothing without a read-only repository share, so refuse to deploy
# an app that would only ever report itself as not ready.
REPOSITORY_SOURCE="${REPOSITORY_SOURCE:-}"
if [[ -z "$REPOSITORY_SOURCE" ]]; then
  cat >&2 <<'USAGE'
REPOSITORY_SOURCE is required. Provide a read-only share that this deployment may mount, for example:

  export REPOSITORY_SOURCE='{"kind":"nfsAzureFile","server":"<account>.file.core.windows.net","shareName":"repositories"}'
  export REPOSITORY_SOURCE='{"kind":"azureFile","accountName":"<account>","shareName":"repositories","accountKeySecretUri":"<key vault secret url>"}'

Synchronize repositories into that share outside this service. This server never clones or fetches.
USAGE
  exit 1
fi

az bicep build --file infra/main.bicep >/dev/null

az deployment sub create \
  --name "${DEPLOYMENT_NAME}-base" \
  --location "$LOCATION" \
  --template-file infra/main.bicep \
  --parameters \
    environmentName="$ENVIRONMENT_NAME" \
    location="$LOCATION" \
    deployApp=false \
    bootstrapPrincipalObjectId="$BOOTSTRAP_PRINCIPAL_OBJECT_ID" \
  --only-show-errors >/dev/null

RESOURCE_GROUP="$(az deployment sub show --name "${DEPLOYMENT_NAME}-base" --query properties.outputs.resourceGroupName.value -o tsv)"
REGISTRY_NAME="$(az deployment sub show --name "${DEPLOYMENT_NAME}-base" --query properties.outputs.registryName.value -o tsv)"
REGISTRY_SERVER="$(az deployment sub show --name "${DEPLOYMENT_NAME}-base" --query properties.outputs.registryLoginServer.value -o tsv)"
KEY_VAULT_NAME="$(az deployment sub show --name "${DEPLOYMENT_NAME}-base" --query properties.outputs.keyVaultName.value -o tsv)"
printf 'Provisioned shared resources in %s.\n' "$RESOURCE_GROUP"

if [[ -z "${API_KEY:-}" ]]; then
  API_KEY="$(openssl rand -hex 32)"
  printf 'Generated an API key. Retrieve it from Key Vault; it will not be printed.\n'
fi

for attempt in {1..12}; do
  if az keyvault secret set \
    --vault-name "$KEY_VAULT_NAME" \
    --name "$SECRET_NAME" \
    --value "$API_KEY" \
    --only-show-errors >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 12 ]]; then
    printf 'Timed out waiting for the bootstrap Key Vault role assignment.\n' >&2
    exit 1
  fi
  sleep 10
done
unset API_KEY

az acr build \
  --registry "$REGISTRY_NAME" \
  --image "agent-tool-server:${IMAGE_TAG}" \
  --build-arg "GIT_SHA=${IMAGE_TAG}" \
  --build-arg "SERVICE_VERSION=${SERVICE_VERSION:-0.1.0}" \
  . \
  --only-show-errors

az deployment sub create \
  --name "${DEPLOYMENT_NAME}-app" \
  --location "$LOCATION" \
  --template-file infra/main.bicep \
  --parameters \
    environmentName="$ENVIRONMENT_NAME" \
    location="$LOCATION" \
    deployApp=true \
    bootstrapPrincipalObjectId="$BOOTSTRAP_PRINCIPAL_OBJECT_ID" \
    containerImage="${REGISTRY_SERVER}/agent-tool-server:${IMAGE_TAG}" \
    repositorySource="$REPOSITORY_SOURCE" \
    repositoryMountPath="${REPOSITORY_MOUNT_PATH:-/repositories}" \
  --only-show-errors

SKIPPED="$(az deployment sub show --name "${DEPLOYMENT_NAME}-app" --query properties.outputs.appSkippedReason.value -o tsv)"
if [[ -n "$SKIPPED" ]]; then
  printf 'The application was not deployed: %s\n' "$SKIPPED" >&2
  exit 1
fi
