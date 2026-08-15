using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus'
param deployApp = false
param containerImage = 'replace.invalid/agent-tool-server:replace-me'

// Supply a read-only repository share before setting deployApp = true. Examples:
//   { kind: 'nfsAzureFile', server: '<account>.file.core.windows.net', shareName: 'repositories' }
//   { kind: 'azureFile', accountName: '<account>', shareName: 'repositories', accountKeySecretUri: '<key vault secret url>' }
param repositorySource = {
  kind: 'none'
}
param repositoryMountPath = '/repositories'

param cpu = '0.5'
param memory = '1.0Gi'
param minReplicas = 0
param maxReplicas = 3
param httpConcurrency = 20
param gitConcurrency = 4
param gitQueueLimit = 32
param gitTimeoutMs = 20000
param gitMaxFiles = 200
param shutdownGraceSeconds = 10
param trustRepositoryOwnership = true
param extraIgnoredDirectories = ''
param logLevel = 'info'
param alertsEnabled = false
param alertActionGroupIds = []
param additionalTags = {}
