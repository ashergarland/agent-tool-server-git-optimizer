# Azure Container Apps deployment example

This example is replaceable hosting scaffolding. It does not add Azure product logic to the tool
server.

## Prerequisites

- Azure CLI with the Bicep CLI installed
- Docker
- permission to create subscription deployments, a resource group, role assignments, and the
  included resources
- a signed-in human user that can be granted Key Vault Secrets Officer during bootstrap
- a selected subscription (`az account set --subscription ...`)

Do not place subscription IDs, tenant IDs, credentials, or generated deployment names in tracked
files.

## Safe two-pass provisioning

```bash
./scripts/bootstrap/provision.sh dev eastus
```

The script:

1. validates and deploys shared resources with `deployApp=false`;
2. prompts for or generates an API key and writes it directly to Key Vault;
3. signs in to the created registry, builds and pushes the image;
4. deploys again with `deployApp=true`.

The first pass prevents Container Apps from repeatedly starting with a missing Key Vault secret.
The second pass adds the app, probes, scale rules, and monitoring after its prerequisites exist.

For automation, set `API_KEY` in the job's protected secret environment and set `IMAGE_TAG` to an
immutable commit SHA. Do not use `latest` for production releases.

## Identity and secrets

The Container App uses a user-assigned managed identity to pull from ACR and read the Key Vault
secret. No registry password or API key is embedded in Bicep. Add provider-specific role
assignments in a separate module and grant only the actions required by registered tools.

The interactive bootstrap user receives Key Vault Secrets Officer so it can seed and rotate this
secret. Remove that assignment after handoff if a separate deployment identity manages rotation.

## Operations

The app scales from zero to three replicas and uses `/health` for liveness and readiness. Log
Analytics and workspace-based Application Insights are provisioned. Configure alert receivers in
your organization rather than committing personal addresses.

Rotate the API key by adding the replacement to `API_KEYS`, deploying, moving clients, then removing
the old key. Key Vault references are versionless; create a new revision or restart replicas after
rotation.

Destroy the example by deleting its generated resource group after confirming it contains no
shared resources.
