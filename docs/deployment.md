# Azure Container Apps deployment example

This example is replaceable hosting scaffolding. It adds no Azure product logic to the tool server.

Hosted operation is optional. The primary mode is local stdio MCP inside a coding workspace, where
no deployment is involved at all. Deploy this only when several clients need a shared endpoint over
repositories you can already mount read-only.

## What a hosted deployment can and cannot analyze

The tool server never clones, fetches, or synchronizes anything. It can only analyze repositories
that are already present in its filesystem. A Container App with no repository mount can serve
`/health`, `/version`, and `/openapi.json`, but `/ready` reports `not-ready` and every tool call is
refused. For that reason `deployApp` defaults to `false`, and the application is skipped entirely
unless `repositorySource.kind` is something other than `none`.

Synchronizing repositories into that share is your responsibility and must happen outside this
service, with your own credentials.

## Prerequisites

- Azure CLI with the Bicep CLI installed
- Docker
- permission to create subscription deployments, a resource group, role assignments, and the
  included resources
- a signed-in human user that can be granted Key Vault Secrets Officer during bootstrap
- a selected subscription (`az account set --subscription ...`)
- a file share holding the repositories you want analyzed

Do not place subscription IDs, tenant IDs, credentials, or generated deployment names in tracked
files.

## Read-only repository sources

`repositorySource` selects how repositories reach the app. The mount is always created with
`accessMode: 'ReadOnly'`.

```bicep
// NFS Azure Files: no account key exists anywhere in the deployment.
param repositorySource = {
  kind: 'nfsAzureFile'
  server: '<account>.file.core.windows.net'
  shareName: 'repositories'
}

// SMB Azure Files: the account key is read from Key Vault with the deployment identity.
param repositorySource = {
  kind: 'azureFile'
  accountName: '<account>'
  shareName: 'repositories'
  accountKeySecretUri: 'https://<vault>.vault.azure.net/secrets/<name>'
}
```

Container Apps does not support identity-only mounting of SMB Azure Files, so the SMB option reads
its key from Key Vault through the user-assigned identity rather than embedding it in the template.
NFS Azure Files needs no key at all and is preferred where available.

Mounted shares are usually owned by a different user than the container's `node` user, so
`trustRepositoryOwnership` defaults to `true`. It adds `safe.directory=*` to Git, which is safe here
only because external diff drivers, text conversion, hooks, credential helpers, and repository
maintenance are all disabled independently.

## Safe two-pass provisioning

```bash
export REPOSITORY_SOURCE='{"kind":"nfsAzureFile","server":"<account>.file.core.windows.net","shareName":"repositories"}'
./scripts/bootstrap/provision.sh dev eastus
```

The script:

1. validates and deploys shared resources with `deployApp=false`;
2. prompts for or generates an API key and writes it directly to Key Vault;
3. signs in to the created registry, builds and pushes the image;
4. deploys again with `deployApp=true` and your repository source;
5. fails loudly if the application was skipped for lack of a repository source.

The first pass prevents Container Apps from repeatedly starting with a missing Key Vault secret.
The second pass adds the app, probes, scale rules, and monitoring after its prerequisites exist.

For automation, set `API_KEY` in the job's protected secret environment and set `IMAGE_TAG` to an
immutable commit SHA. Do not use `latest` for production releases.

## Sizing and limits

Every operational knob is a parameter, so no redeployment of the image is needed to retune:

| Parameter                              | Default        | Purpose                                 |
| -------------------------------------- | -------------- | --------------------------------------- |
| `cpu`, `memory`                        | `0.5`, `1.0Gi` | Per-replica resources                   |
| `minReplicas`, `maxReplicas`           | `0`, `3`       | Scale-to-zero through burst             |
| `httpConcurrency`                      | `20`           | Requests per replica before scaling out |
| `gitConcurrency`, `gitQueueLimit`      | `4`, `32`      | Git worker pool and backpressure        |
| `gitTimeoutMs`, `gitMaxFiles`          | `20000`, `200` | Per-command and per-result bounds       |
| `shutdownGraceSeconds`                 | `10`           | Bounded drain on SIGTERM                |
| `extraIgnoredDirectories`              | empty          | Project-specific generated directories  |
| `alertsEnabled`, `alertActionGroupIds` | `false`, `[]`  | Optional server-error alerting          |
| `additionalTags`                       | `{}`           | Merged onto every resource              |

Git work is CPU and IO bound. Keep `gitConcurrency` at or below the vCPU allocation, and raise
`httpConcurrency` only alongside it.

## Identity, secrets, and the container

The Container App uses a user-assigned managed identity to pull from ACR, read the Key Vault
secret, and read the storage account key when SMB Azure Files is used. No registry password, API
key, storage key, or repository is embedded in Bicep or in the image.

The image runs as the non-root `node` user, ships a version-verified Git, and needs no writable
layer beyond temporary space. Run it with a read-only root filesystem:

```bash
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  -v /srv/repositories:/repositories:ro \
  -e API_KEYS="$API_KEY" -e GIT_ALLOWED_ROOTS=/repositories \
  -e GIT_TRUST_REPOSITORY_OWNERSHIP=true \
  -p 8080:8080 agent-tool-server-git-optimizer:test
```

The interactive bootstrap user receives Key Vault Secrets Officer so it can seed and rotate the API
key. Remove that assignment after handoff if a separate deployment identity manages rotation.

## Operations

Liveness uses `/health`; readiness uses `/ready`, which verifies the Git executable, temporary
storage, and every configured repository root without reading repository content. A replica whose
mount has disappeared drops out of rotation instead of failing calls.

Scale-to-zero is retained, so the first request after idle pays a cold start. Set `minReplicas` to
`1` if that latency matters.

Log Analytics and workspace-based Application Insights are provisioned. Structured logs record
invocation latency and outcome, queue depth, returned file counts, truncation, Git timeouts and
failures, authentication failures, and rate limiting. They never record patches, commit messages,
or credentials. Configure alert receivers in your organization rather than committing personal
addresses.

Rotate the API key by adding the replacement to `API_KEYS`, deploying, moving clients, then removing
the old key. Key Vault references are versionless; create a new revision or restart replicas after
rotation.

Destroy the example by deleting its generated resource group after confirming it contains no
shared resources.
