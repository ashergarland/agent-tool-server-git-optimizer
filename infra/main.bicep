targetScope = 'subscription'

@description('Short environment suffix such as dev, test, or prod.')
@minLength(2)
@maxLength(12)
param environmentName string

@description('Azure region for all resources.')
param location string = deployment().location

@description('Immutable container image reference used on the second pass.')
param containerImage string = 'replace.invalid/agent-tool-server:replace-me'

@description('False for the prerequisite pass; true only after the Key Vault secret, image, and repository source exist.')
param deployApp bool = false

@description('Existing Key Vault secret name used by the application.')
param apiKeySecretName string = 'tool-server-api-key'

@description('Object ID allowed to seed the Key Vault secret during bootstrap; leave blank outside bootstrap.')
param bootstrapPrincipalObjectId string = ''

@description('''
Read-only repository source mounted into the app. The server can analyze nothing without one.
  { kind: 'none' }
  { kind: 'nfsAzureFile', server: '<account>.file.core.windows.net', shareName: '<share>' }
  { kind: 'azureFile', accountName: '<account>', shareName: '<share>', accountKeySecretUri: '<key vault secret url>' }
Azure Files keys are read from Key Vault with the deployment identity, never from this template.
''')
param repositorySource object = {
  kind: 'none'
}

@description('Absolute mount path, which is also the only allowed Git root.')
param repositoryMountPath string = '/repositories'

@description('vCPU per replica.')
param cpu string = '0.5'

@description('Memory per replica.')
param memory string = '1.0Gi'

@description('Minimum replicas. Keep zero for scale-to-zero.')
@minValue(0)
param minReplicas int = 0

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 3

@description('Concurrent HTTP requests per replica before scaling out.')
@minValue(1)
param httpConcurrency int = 20

@description('Concurrent Git child processes per replica.')
@minValue(1)
param gitConcurrency int = 4

@description('Queued Git jobs per replica before callers receive a retryable busy error.')
@minValue(0)
param gitQueueLimit int = 32

@description('Per-command Git timeout in milliseconds.')
@minValue(1000)
param gitTimeoutMs int = 20000

@description('Maximum files returned by a single summary.')
@minValue(1)
param gitMaxFiles int = 200

@description('Seconds the process may drain in-flight work before exiting.')
@minValue(0)
param shutdownGraceSeconds int = 10

@description('Trust repositories owned by another user; required for most read-only mounts.')
param trustRepositoryOwnership bool = true

@description('Additional generated directories filtered from summaries, comma separated.')
param extraIgnoredDirectories string = ''

@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
param logLevel string = 'info'

@description('Resource IDs of action groups notified by the included alerts.')
param alertActionGroupIds array = []

@description('Disables alert rules when an adopter manages alerting elsewhere.')
param alertsEnabled bool = false

@description('Additional tags merged onto every resource.')
param additionalTags object = {}

var suffix = uniqueString(subscription().id, environmentName)
var resourceGroupName = 'rg-ats-${environmentName}-${suffix}'
var baseTags = union(
  {
    application: 'agent-tool-server-git-optimizer'
    environment: environmentName
    managedBy: 'bicep'
  },
  additionalTags
)

// The app is only useful with a read-only repository source, so it is never deployed without one.
var repositoryConfigured = repositorySource.kind != 'none'
var deployAppNow = deployApp && repositoryConfigured

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: baseTags
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: resourceGroup
  params: {
    location: location
    name: 'id-ats-${environmentName}-${suffix}'
    tags: baseTags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'registry'
  scope: resourceGroup
  params: {
    location: location
    name: 'crats${suffix}'
    pullPrincipalId: identity.outputs.principalId
    tags: baseTags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  scope: resourceGroup
  params: {
    location: location
    name: 'kv-ats-${suffix}'
    accessPrincipalObjectId: identity.outputs.principalId
    bootstrapPrincipalObjectId: bootstrapPrincipalObjectId
    tags: baseTags
  }
}

module observability 'modules/observability.bicep' = {
  name: 'observability'
  scope: resourceGroup
  params: {
    location: location
    workspaceName: 'log-ats-${environmentName}-${suffix}'
    insightsName: 'appi-ats-${environmentName}-${suffix}'
    tags: baseTags
  }
}

module app 'modules/container-app.bicep' = if (deployAppNow) {
  name: 'container-app'
  scope: resourceGroup
  params: {
    location: location
    environmentName: 'cae-ats-${environmentName}-${suffix}'
    appName: 'ca-ats-${environmentName}-${suffix}'
    containerImage: containerImage
    registryServer: registry.outputs.loginServer
    identityId: identity.outputs.id
    apiKeySecretUri: '${keyVault.outputs.vaultUri}secrets/${apiKeySecretName}'
    logAnalyticsCustomerId: observability.outputs.workspaceCustomerId
    logAnalyticsSharedKey: observability.outputs.workspaceSharedKey
    applicationInsightsConnectionString: observability.outputs.applicationInsightsConnectionString
    repositorySource: repositorySource
    repositoryMountPath: repositoryMountPath
    cpu: cpu
    memory: memory
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    httpConcurrency: httpConcurrency
    gitConcurrency: gitConcurrency
    gitQueueLimit: gitQueueLimit
    gitTimeoutMs: gitTimeoutMs
    gitMaxFiles: gitMaxFiles
    shutdownGraceSeconds: shutdownGraceSeconds
    trustRepositoryOwnership: trustRepositoryOwnership
    extraIgnoredDirectories: extraIgnoredDirectories
    logLevel: logLevel
    alertActionGroupIds: alertActionGroupIds
    alertsEnabled: alertsEnabled
    tags: baseTags
  }
}

output resourceGroupName string = resourceGroupName
output registryName string = registry.outputs.name
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output managedIdentityClientId string = identity.outputs.clientId
output applicationUrl string = deployAppNow ? 'https://${app!.outputs.fqdn}' : ''
output appDeployed bool = deployAppNow
output appSkippedReason string = deployApp && !repositoryConfigured
  ? 'repositorySource.kind is "none"; supply a read-only Azure Files or NFS share before deploying the app'
  : ''
