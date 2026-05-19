// =============================================================================
// Blue Collar Coach Connect — main Bicep template
// Provisions: App Service Plan, Linux Web App, Azure SQL Server + DB,
// SignalR Service, Application Insights, Storage Account.
//
// Tier picker (`tier` parameter):
//   "free"   → F1 App Service + SQL serverless (free offer) + SignalR Free_F1
//   "dev"    → B1 + SQL serverless GP_S + SignalR Free_F1
//   "prod"   → B2 + SQL serverless GP_S + SignalR Standard_S1
//
// Usage:
//   az login
//   az group create --name rg-bcc-connect --location eastus
//   az deployment group create -g rg-bcc-connect \
//     --template-file infra/azure/main.bicep \
//     --parameters @infra/azure/main.parameters.json
// =============================================================================

@description('Base name prefix (lowercase, 3-12 chars).')
@minLength(3)
@maxLength(12)
param name string = 'bccconnect'

@description('Azure region.')
param location string = resourceGroup().location

@description('Deployment tier: "free" (≈$0), "dev" (≈$25/mo), or "prod" (≈$130/mo).')
@allowed(['free', 'dev', 'prod'])
param tier string = 'free'

@description('Azure SQL admin login.')
param sqlAdminLogin string

@description('Azure SQL admin password.')
@secure()
@minLength(12)
param sqlAdminPassword string

@description('Auth.js secret. Generate with: openssl rand -base64 32')
@secure()
@minLength(32)
param authSecret string

@description('Microsoft Entra app client id (optional).')
param entraClientId string = ''

@description('Microsoft Entra app client secret (optional).')
@secure()
param entraClientSecret string = ''

@description('Microsoft Entra tenant id (or "common" for multi-tenant).')
param entraTenantId string = 'common'

@description('QBO client id (optional).')
param qboClientId string = ''

@description('QBO client secret (optional).')
@secure()
param qboClientSecret string = ''

// ---------- Tier-derived SKUs ----------
var appServiceSku  = tier == 'free' ? 'F1' : (tier == 'dev' ? 'B1' : 'B2')
var appServiceTier = tier == 'free' ? 'Free' : 'Basic'
var signalRSku     = tier == 'prod' ? 'Standard_S1' : 'Free_F1'
var signalRCapacity = tier == 'prod' ? 1 : 1
var useSqlFreeLimit = tier == 'free'   // SQL "free offer" (one DB per sub per region)

var unique = uniqueString(resourceGroup().id)
var planName     = '${name}-plan-${unique}'
var appName      = '${name}-web-${unique}'
var sqlServer    = '${name}-sql-${unique}'
var sqlDbName    = '${name}-db'
var signalRName  = '${name}-sr-${unique}'
var insightsName = '${name}-ai-${unique}'
var storageName  = take(toLower(replace('${name}st${unique}', '-', '')), 24)

// --- Application Insights ---
resource ai 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    IngestionMode: 'ApplicationInsights'
  }
}

// --- App Service plan ---
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  sku: { name: appServiceSku, tier: appServiceTier }
  kind: 'linux'
  properties: { reserved: true }
}

// --- Storage (docs) ---
resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  name: '${storage.name}/default/bcc-docs'
  properties: { publicAccess: 'None' }
}

// --- SQL Server + DB ---
resource sql 'Microsoft.Sql/servers@2024-05-01-preview' = {
  name: sqlServer
  location: location
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

resource sqlAllowAzure 'Microsoft.Sql/servers/firewallRules@2024-05-01-preview' = {
  parent: sql
  name: 'AllowAllAzureIPs'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource db 'Microsoft.Sql/servers/databases@2024-05-01-preview' = {
  parent: sql
  name: sqlDbName
  location: location
  sku: { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 }
  properties: union(
    {
      autoPauseDelay: 60
      minCapacity: json('0.5')
      maxSizeBytes: 34359738368
    },
    useSqlFreeLimit ? {
      // Azure SQL Database "free offer" — 100k vCore-seconds + 32 GB free
      // (one DB per subscription per region). Requires Gen5 serverless.
      useFreeLimit: true
      freeLimitExhaustionBehavior: 'AutoPause'
    } : {}
  )
}

// --- SignalR Service ---
resource sr 'Microsoft.SignalRService/signalR@2024-08-01-preview' = {
  name: signalRName
  location: location
  sku: { name: signalRSku, capacity: signalRCapacity }
  kind: 'SignalR'
  properties: {
    features: [
      { flag: 'ServiceMode', value: 'Serverless' }
    ]
  }
}

// --- Web App ---
var dbConnString = 'sqlserver://${sql.properties.fullyQualifiedDomainName}:1433;database=${sqlDbName};user=${sqlAdminLogin};password=${sqlAdminPassword};encrypt=true;trustServerCertificate=false'
var storageConnString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${listKeys(storage.id, '2024-01-01').keys[0].value};EndpointSuffix=core.windows.net'
var signalRConnString = listKeys(sr.id, '2024-08-01-preview').primaryConnectionString

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      // F1 (Free) does NOT support Always On — Azure rejects the deploy otherwise.
      alwaysOn: tier != 'free'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'WEBSITES_PORT',                value: '3000' }
        { name: 'NODE_ENV',                     value: 'production' }
        { name: 'NEXT_PUBLIC_APP_URL',          value: 'https://${appName}.azurewebsites.net' }
        { name: 'NEXT_PUBLIC_APP_NAME',         value: 'Blue Collar Coach Connect' }
        { name: 'DATABASE_URL',                 value: dbConnString }
        { name: 'AUTH_SECRET',                  value: authSecret }
        { name: 'AUTH_TRUST_HOST',              value: 'true' }
        { name: 'DEV_AUTH_BYPASS',              value: tier == 'free' ? 'true' : 'false' }
        { name: 'AUTH_MICROSOFT_ENTRA_ID',      value: entraClientId }
        { name: 'AUTH_MICROSOFT_ENTRA_SECRET',  value: entraClientSecret }
        { name: 'AUTH_MICROSOFT_ENTRA_TENANT_ID', value: entraTenantId }
        { name: 'QBO_CLIENT_ID',                value: qboClientId }
        { name: 'QBO_CLIENT_SECRET',            value: qboClientSecret }
        { name: 'QBO_ENVIRONMENT',              value: 'sandbox' }
        { name: 'SIGNALR_CONNECTION_STRING',    value: signalRConnString }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: ai.properties.ConnectionString }
        { name: 'NEXT_PUBLIC_APPINSIGHTS_CONNECTION_STRING', value: ai.properties.ConnectionString }
        { name: 'AZURE_STORAGE_CONNECTION_STRING', value: storageConnString }
        { name: 'AZURE_STORAGE_CONTAINER_DOCS', value: 'bcc-docs' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'ENABLE_ORYX_BUILD',             value: 'true' }
      ]
    }
  }
}

output appUrl string = 'https://${app.properties.defaultHostName}'
output appName string = app.name
output sqlFqdn string = sql.properties.fullyQualifiedDomainName
output sqlDbName string = sqlDbName
output sqlAdminLogin string = sqlAdminLogin
output insightsConn string = ai.properties.ConnectionString
output signalRHost string = sr.properties.hostName
output storageAccount string = storage.name
