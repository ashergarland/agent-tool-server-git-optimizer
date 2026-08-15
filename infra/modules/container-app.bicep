@description('Region for the container app and its managed environment.')
param location string

@description('Name of the managed environment created for this app.')
param environmentName string

@description('Name of the container app.')
param appName string

@description('Immutable image reference, ideally digest-pinned.')
param containerImage string

@description('Login server of the registry holding the image.')
param registryServer string

@description('Resource ID of the user-assigned identity used for pulls, Key Vault, and storage.')
param identityId string

@description('Key Vault secret URI holding the API key.')
param apiKeySecretUri string

param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string
@secure()
param applicationInsightsConnectionString string

@description('Read-only repository source mounted into the app. Kind "none" leaves the tool unusable.')
param repositorySource object

@description('Absolute path the repository source is mounted at, and the only allowed Git root.')
param repositoryMountPath string

@description('vCPU allocated to the container.')
param cpu string

@description('Memory allocated to the container, for example 0.5Gi.')
param memory string

@minValue(0)
param minReplicas int

@minValue(1)
param maxReplicas int

@description('Concurrent HTTP requests per replica before scaling out.')
@minValue(1)
param httpConcurrency int

@description('Concurrent Git child processes per replica.')
@minValue(1)
param gitConcurrency int

@description('Queued Git jobs per replica before callers receive a retryable busy error.')
@minValue(0)
param gitQueueLimit int

@description('Per-command Git timeout in milliseconds.')
@minValue(1000)
param gitTimeoutMs int

@description('Maximum files returned by a single summary.')
@minValue(1)
param gitMaxFiles int

@description('Seconds the process may drain in-flight work before exiting.')
@minValue(0)
param shutdownGraceSeconds int

@description('Trust repositories owned by another user; required for most read-only mounts.')
param trustRepositoryOwnership bool

@description('Additional generated directories filtered from summaries, comma separated.')
param extraIgnoredDirectories string

param logLevel string
param tags object

@description('Resource IDs of action groups notified by the included alerts.')
param alertActionGroupIds array

@description('Disables alert rules when an adopter manages alerting elsewhere.')
param alertsEnabled bool

var mountsRepository = repositorySource.kind != 'none'
var volumeName = 'repositories'

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

// Always read-only: the tool server must never be able to write to a mounted repository.
resource repositoryStorage 'Microsoft.App/managedEnvironments/storages@2025-07-01' = if (mountsRepository) {
  name: volumeName
  parent: environment
  properties: repositorySource.kind == 'nfsAzureFile'
    ? {
        nfsAzureFile: {
          accessMode: 'ReadOnly'
          server: repositorySource.server
          shareName: repositorySource.shareName
        }
      }
    : {
        azureFile: {
          accessMode: 'ReadOnly'
          accountName: repositorySource.accountName
          shareName: repositorySource.shareName
          accountKeyVaultProperties: {
            identity: identityId
            keyVaultUrl: repositorySource.accountKeySecretUri
          }
        }
      }
}

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registryServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'api-key'
          keyVaultUrl: apiKeySecretUri
          identity: identityId
        }
      ]
    }
    template: {
      volumes: mountsRepository
        ? [
            {
              name: volumeName
              storageType: repositorySource.kind == 'nfsAzureFile' ? 'NfsAzureFile' : 'AzureFile'
              storageName: repositoryStorage!.name
            }
          ]
        : []
      containers: [
        {
          name: 'tool-server'
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          volumeMounts: mountsRepository
            ? [
                {
                  volumeName: volumeName
                  mountPath: repositoryMountPath
                }
              ]
            : []
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'LOG_LEVEL'
              value: logLevel
            }
            {
              name: 'AUTH_MODE'
              value: 'api-key'
            }
            {
              name: 'API_KEYS'
              secretRef: 'api-key'
            }
            {
              name: 'GIT_ALLOWED_ROOTS'
              value: repositoryMountPath
            }
            {
              name: 'GIT_LOCAL_PATHS_ENABLED'
              value: 'false'
            }
            {
              name: 'GIT_TRUST_REPOSITORY_OWNERSHIP'
              value: string(trustRepositoryOwnership)
            }
            {
              name: 'GIT_EXTRA_IGNORED_DIRECTORIES'
              value: extraIgnoredDirectories
            }
            {
              name: 'GIT_CONCURRENCY'
              value: string(gitConcurrency)
            }
            {
              name: 'GIT_QUEUE_LIMIT'
              value: string(gitQueueLimit)
            }
            {
              name: 'GIT_TIMEOUT_MS'
              value: string(gitTimeoutMs)
            }
            {
              name: 'GIT_MAX_FILES'
              value: string(gitMaxFiles)
            }
            {
              name: 'SHUTDOWN_GRACE_MS'
              value: string(shutdownGraceSeconds * 1000)
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: applicationInsightsConnectionString
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(httpConcurrency)
              }
            }
          }
        ]
      }
    }
  }
}

resource failureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (alertsEnabled) {
  name: '${appName}-server-errors'
  location: 'global'
  tags: tags
  properties: {
    description: 'Container app replicas are returning server errors.'
    severity: 2
    enabled: true
    scopes: [app.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Requests5xx'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'statusCodeCategory'
              operator: 'Include'
              values: ['5xx']
            }
          ]
        }
      ]
    }
    actions: [
      for actionGroupId in alertActionGroupIds: {
        actionGroupId: actionGroupId
      }
    ]
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output repositoryMounted bool = mountsRepository
