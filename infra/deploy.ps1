# Precision Connect — one-shot Azure deployment.
# See DEPLOY.md for the prereqs (Entra app registration, GitHub repo, az login).
#
# Usage:
#   ./deploy.ps1 -Subscription <sub-id> -ResourceGroup precision-connect -Location centralus `
#                -RepoUrl https://github.com/you/precision-connect -RepoToken ghp_... `
#                -EntraTenantId 11111111-... -EntraClientId 22222222-... -EntraClientSecret xxxx
#
# After deployment finishes, the output prints the SWA default hostname.

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)] [string]$Subscription,
  [Parameter(Mandatory=$true)] [string]$ResourceGroup,
  [string]$Location = 'westus2',
  [Parameter(Mandatory=$true)] [string]$RepoUrl,
  [Parameter(Mandatory=$true)] [string]$RepoToken,
  [Parameter(Mandatory=$true)] [string]$EntraTenantId,
  [Parameter(Mandatory=$true)] [string]$EntraClientId,
  [Parameter(Mandatory=$true)] [string]$EntraClientSecret,
  [string]$Branch = 'main',
  [string]$BccTenantId = 'blue-collar-coach',
  [bool]$EnableCosmosFreeTier = $true
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==> Setting subscription $Subscription"
az account set --subscription $Subscription | Out-Null

Write-Host "==> Ensuring resource group $ResourceGroup in $Location"
az group create --name $ResourceGroup --location $Location | Out-Null

$deploymentName = "pc-deploy-$(Get-Date -Format yyyyMMddHHmmss)"
Write-Host "==> Deploying Bicep ($deploymentName)"

az deployment group create `
  --name $deploymentName `
  --resource-group $ResourceGroup `
  --template-file (Join-Path $scriptDir 'main.bicep') `
  --parameters `
    appName=bcc-connect `
    swaLocation=$Location `
    enableCosmosFreeTier=$EnableCosmosFreeTier `
    repositoryUrl=$RepoUrl `
    branch=$Branch `
    repositoryToken=$RepoToken `
    entraTenantId=$EntraTenantId `
    entraClientId=$EntraClientId `
    entraClientSecret=$EntraClientSecret `
    bccTenantId=$BccTenantId `
  --output table

Write-Host ""
Write-Host "==> Outputs:"
$outputs = az deployment group show --resource-group $ResourceGroup --name $deploymentName --query properties.outputs | ConvertFrom-Json
$outputs | Format-List

Write-Host ""
Write-Host "Done. App URL: https://$($outputs.swaDefaultHostname.value)"
Write-Host "Next: in the Azure portal, open the Static Web App > Role management"
Write-Host "      and invite yourself with the 'administrator' role so /admin.html works."
