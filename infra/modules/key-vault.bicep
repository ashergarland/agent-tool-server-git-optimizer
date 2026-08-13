param location string
param name string
param accessPrincipalObjectId string
param bootstrapPrincipalObjectId string
param tags object

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

resource secretReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, accessPrincipalObjectId, 'key-vault-secrets-user')
  scope: vault
  properties: {
    principalId: accessPrincipalObjectId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
  }
}

resource bootstrapSecretOfficerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(bootstrapPrincipalObjectId)) {
  name: guid(vault.id, bootstrapPrincipalObjectId, 'key-vault-secrets-officer')
  scope: vault
  properties: {
    principalId: bootstrapPrincipalObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
    )
  }
}

output name string = vault.name
output vaultUri string = vault.properties.vaultUri
