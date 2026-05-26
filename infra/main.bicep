// BCC Connect — Azure infrastructure (Free tier).
// Provisions:
//   - Cosmos DB account (Free Tier enabled — one per subscription)
//   - SQL database + container with /tenantId partition key
//   - Static Web App (Free SKU) wired to a GitHub repo + branch
//   - App settings on the SWA: COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DB,
//     COSMOS_CONTAINER, BCC_TENANT_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID,
//     AZURE_CLIENT_SECRET
//
// Notes
//   - SWA Free tier only deploys from a public-ish GitHub repo via the
//     azure_static_web_apps_api_token. If you'd rather provision SWA later via
//     the portal and just provision Cosmos here, comment out the SWA block.
//   - AZURE_CLIENT_ID / AZURE_CLIENT_SECRET come from the Entra ID app you
//     create in DEPLOY.md step 5. Pass them in as parameters.
//   - Region: SWA Free is only available in a small set of regions; centralus,
//     westus2, eastus2, westeurope, eastasia are safe picks.

targetScope = 'resourceGroup'

@description('Short app name. Used to derive resource names.')
param appName string = 'bcc-connect'

@description('Azure region for resources.')
param location string = resourceGroup().location

@description('SWA region (Free SKU is only available in select regions).')
@allowed([ 'centralus', 'eastus2', 'westus2', 'westeurope', 'eastasia' ])
param swaLocation string = 'centralus'

@description('Enable Cosmos Free Tier (1000 RU/s + 25 GB). Only one free-tier account allowed per subscription.')
param enableCosmosFreeTier bool = true

@description('GitHub repository URL, e.g. https://github.com/blue-collar-coach/bcc-connect')
param repositoryUrl string

@description('Branch to deploy from.')
param branch string = 'main'

@description('GitHub PAT with repo scope (set as a secure parameter at deploy time).')
@secure()
param repositoryToken string

@description('Entra ID (Azure AD) tenant ID — the GUID, e.g. 11111111-2222-3333-4444-555555555555')
param entraTenantId string

@description('Entra ID app registration client ID.')
param entraClientId string

@description('Entra ID app registration client secret (set as a secure parameter at deploy time).')
@secure()
param entraClientSecret string

@description('Tenant identifier used inside the app to scope all docs (e.g. blue-collar-coach).')
param bccTenantId string = 'blue-collar-coach'

@description('VAPID public key for Web Push (base64url ECDH P-256). Generate with: npx web-push generate-vapid-keys. Empty disables push notifications.')
param vapidPublicKey string = ''

@description('VAPID private key for Web Push. Pair with vapidPublicKey. Empty disables push.')
@secure()
param vapidPrivateKey string = ''

@description('Contact for VAPID subject (mailto: URL recommended).')
param vapidSubject string = 'mailto:admin@bluecollarcoach.us'

@description('Custom hostnames to bind to the Static Web App. CNAMEs at the DNS level must already point at the SWA default hostname; Azure issues a free managed cert per entry once validation passes. Pass an empty array on first deploy — bind the custom hostname later once the CNAME is in place (see DEPLOY.md).')
param customHostnames array = []

var cosmosAccountName  = toLower('${appName}-cdb-${uniqueString(resourceGroup().id)}')
var cosmosDatabaseName = 'bcc-connect'
var cosmosContainerName = 'data'
var swaName            = '${appName}-swa'

// ----------------------------- Cosmos DB ----------------------------- //
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: enableCosmosFreeTier
    enableAutomaticFailover: false
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: []
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 1440
        backupRetentionIntervalInHours: 168
        backupStorageRedundancy: 'Local'
      }
    }
  }
}

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: cosmosDatabaseName
  properties: {
    resource: { id: cosmosDatabaseName }
    options: { throughput: 1000 } // free-tier RU/s; ignored if account isn't free-tier
  }
}

resource cosmosContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: cosmosDb
  name: cosmosContainerName
  properties: {
    resource: {
      id: cosmosContainerName
      partitionKey: {
        paths: [ '/tenantId' ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [ { path: '/*' } ]
        excludedPaths: [ { path: '/"_etag"/?' } ]
      }
      defaultTtl: -1
    }
  }
}

// --------------------------- Static Web App --------------------------- //
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: swaName
  location: swaLocation
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    repositoryUrl: repositoryUrl
    branch: branch
    repositoryToken: repositoryToken
    buildProperties: {
      // Code lives at the repo root in this project (not in a subfolder).
      appLocation: '/'
      apiLocation: '/api'
      outputLocation: ''
    }
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
  }
}

// One custom-hostname binding per entry in `customHostnames`. Azure validates
// each via cname-delegation (the DNS CNAME must already point at the SWA's
// default hostname) and then issues + manages a free TLS certificate for it.
// This is how apps.bluecollarcoach.us gets re-bound automatically on any
// future re-deploy — no portal trip required.
resource swaCustomDomains 'Microsoft.Web/staticSites/customDomains@2023-12-01' = [for hostname in customHostnames: {
  parent: swa
  name: hostname
  properties: {
    validationMethod: 'cname-delegation'
  }
}]

resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    COSMOS_ENDPOINT: cosmos.properties.documentEndpoint
    COSMOS_KEY: cosmos.listKeys().primaryMasterKey
    COSMOS_DB: cosmosDatabaseName
    COSMOS_CONTAINER: cosmosContainerName
    BCC_TENANT_ID: bccTenantId
    AZURE_TENANT_ID: entraTenantId
    AZURE_CLIENT_ID: entraClientId
    AZURE_CLIENT_SECRET: entraClientSecret
    VAPID_PUBLIC_KEY: vapidPublicKey
    VAPID_PRIVATE_KEY: vapidPrivateKey
    VAPID_SUBJECT: vapidSubject
  }
}

// ------------------------------- Outputs ------------------------------- //
output cosmosAccountName   string = cosmos.name
output cosmosEndpoint      string = cosmos.properties.documentEndpoint
output cosmosDatabaseName  string = cosmosDb.name
output cosmosContainerName string = cosmosContainer.name
output swaName             string = swa.name
output swaDefaultHostname  string = swa.properties.defaultHostname
output swaRepositoryUrl    string = repositoryUrl
output swaCustomHostnames  array  = customHostnames
