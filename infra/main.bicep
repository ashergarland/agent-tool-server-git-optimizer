targetScope = 'subscription'

@description('Short environment suffix such as dev, test, or prod.')
@minLength(2)
@maxLength(12)
param environmentName string

@description('Azure region for all resources.')
param location string = deployment().location

@description('Immutable container image reference used on the second pass.')
param containerImage string = 'replace.invalid/agent-tool-server:replace-me'

@description('False for the prerequisite pass; true only after the Key Vault secret and image exist.')
param deployApp bool = false

@description('Enable state-changing tools at the process boundary.')
param mutationsEnabled bool = false

@description('Existing Key Vault secret name used by the application.')
param apiKeySecretName string = 'tool-server-api-key'

@description('Object ID allowed to seed the Key Vault secret during bootstrap; leave blank outside bootstrap.')
param bootstrapPrincipalObjectId string = ''

@description('Minimum replicas. Keep zero for scale-to-zero.')
@minValue(0)
param minReplicas int = 0

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 3

var suffix = uniqueString(subscription().id, environmentName)
var resourceGroupName = 'rg-ats-${environmentName}-${suffix}'

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    application: 'agent-tool-server'
    environment: environmentName
    managedBy: 'bicep'
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: resourceGroup
  params: {
    location: location
    name: 'id-ats-${environmentName}-${suffix}'
    tags: resourceGroup.tags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'registry'
  scope: resourceGroup
  params: {
    location: location
    name: 'crats${suffix}'
    pullPrincipalId: identity.outputs.principalId
    tags: resourceGroup.tags
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
    tags: resourceGroup.tags
  }
}

module observability 'modules/observability.bicep' = {
  name: 'observability'
  scope: resourceGroup
  params: {
    location: location
    workspaceName: 'log-ats-${environmentName}-${suffix}'
    insightsName: 'appi-ats-${environmentName}-${suffix}'
    tags: resourceGroup.tags
  }
}

module app 'modules/container-app.bicep' = if (deployApp) {
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
    mutationsEnabled: mutationsEnabled
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    tags: resourceGroup.tags
  }
}

output resourceGroupName string = resourceGroupName
output registryName string = registry.outputs.name
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output managedIdentityClientId string = identity.outputs.clientId
output applicationUrl string = deployApp ? 'https://${app!.outputs.fqdn}' : ''
