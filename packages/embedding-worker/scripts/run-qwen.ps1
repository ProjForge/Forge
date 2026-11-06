[CmdletBinding()]
param(
    [switch]$Continuous,
    [switch]$EnsureProvider,
    [string]$ConfigRoot = $(if ($env:FORGE_CONFIG_ROOT) { $env:FORGE_CONFIG_ROOT } else { Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE' }),
    [switch]$ValidateConfiguration
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$packageRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $ConfigRoot 'workbench.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing shared FORGE configuration: $configPath" }
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if ($null -eq $config.database -or $null -eq $config.embedding) { throw 'Configuration requires database and embedding objects.' }

function Require-Text([object]$Value, [string]$Name) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { throw "$Name must be a non-empty string." }
    return ([string]$Value).Trim()
}

$databaseHost = Require-Text $config.database.host 'database.host'
$databaseName = Require-Text $config.database.name 'database.name'
$databaseUser = Require-Text $config.database.user 'database.user'
$credentialFile = Require-Text $config.database.credentialFile 'database.credentialFile'
if ([IO.Path]::GetFileName($credentialFile) -ne $credentialFile) { throw 'database.credentialFile must be a file name.' }
$databasePort = if ($null -eq $config.database.port) { 5432 } else { [int]$config.database.port }
if ($databasePort -lt 1 -or $databasePort -gt 65535) { throw 'database.port must be between 1 and 65535.' }
$projectId = Require-Text $config.embedding.projectId 'embedding.projectId'
$parsedProjectId = [Guid]::Empty
if (-not [Guid]::TryParse($projectId, [ref]$parsedProjectId)) { throw 'embedding.projectId must be a UUID.' }
$baseUrl = Require-Text $config.embedding.baseUrl 'embedding.baseUrl'
$providerName = if ($config.embedding.PSObject.Properties.Name -contains 'providerName') { Require-Text $config.embedding.providerName 'embedding.providerName' } else { 'lmstudio-local' }
$model = Require-Text $config.embedding.model 'embedding.model'
$profileKey = Require-Text $config.embedding.profileKey 'embedding.profileKey'
$dimensions = [int]$config.embedding.dimensions
if ($dimensions -lt 1 -or $dimensions -gt 16384) { throw 'embedding.dimensions must be between 1 and 16384.' }
$queryPrefix = Require-Text $config.embedding.queryPrefix 'embedding.queryPrefix'
$credentialPath = Join-Path $ConfigRoot $credentialFile
$statusPath = Join-Path $ConfigRoot 'embedding-worker-status.json'

if ($ValidateConfiguration) {
    [ordered]@{
        valid = $true
        database = [ordered]@{ host = $databaseHost; port = $databasePort; name = $databaseName; user = $databaseUser }
        embedding = [ordered]@{ projectId = $projectId; baseUrl = $baseUrl; providerName = $providerName; model = $model; profileKey = $profileKey; dimensions = $dimensions }
    } | ConvertTo-Json -Depth 4
    exit 0
}

$protectedBytes = $null
$passwordBytes = $null
$password = $null

try {
    if ($EnsureProvider) { & (Join-Path $PSScriptRoot 'start-local-provider.ps1') -ConfigRoot $ConfigRoot | Out-Null }
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $credentialPath)) { throw 'The FORGE DPAPI credential is not configured.' }
    $protectedBytes = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $credentialPath).Trim())
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
    $urlHost = if ($databaseHost.Contains(':') -and -not $databaseHost.StartsWith('[')) { "[$databaseHost]" } else { $databaseHost }
    $env:FORGE_DATABASE_URL = "postgresql://$([Uri]::EscapeDataString($databaseUser)):$([Uri]::EscapeDataString($password))@$urlHost`:$databasePort/$([Uri]::EscapeDataString($databaseName))"
    $env:FORGE_PROJECT_ID = $projectId
    $env:FORGE_EMBEDDING_BASE_URL = $baseUrl
    $env:FORGE_EMBEDDING_PROVIDER_NAME = $providerName
    $env:FORGE_EMBEDDING_MODEL = $model
    $env:FORGE_EMBEDDING_PROFILE_KEY = $profileKey
    $env:FORGE_EMBEDDING_DIMENSIONS = [string]$dimensions
    $env:FORGE_EMBEDDING_QUERY_PREFIX = $queryPrefix
    $env:FORGE_EMBEDDING_CONTINUOUS = $Continuous.IsPresent.ToString().ToLowerInvariant()
    $env:FORGE_EMBEDDING_POLL_INTERVAL_MS = '30000'
    $env:FORGE_EMBEDDING_ERROR_DELAY_MS = '15000'
    $env:FORGE_EMBEDDING_STATUS_FILE = $statusPath
    & (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $packageRoot 'dist\cli.js')
    if ($LASTEXITCODE -ne 0) { throw 'Embedding worker process failed.' }
    exit 0
} catch {
    $temporary = "$statusPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        @{status='FAIL';updatedAt=[datetime]::UtcNow.ToString('o');code='WORKER_START_FAILED'} | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $statusPath -Force
    } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    throw 'FORGE worker startup failed; verify the local provider and shared configuration.'
} finally {
    $password = $null
    if ($null -ne $passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:FORGE_PROJECT_ID, Env:FORGE_EMBEDDING_BASE_URL, Env:FORGE_EMBEDDING_PROVIDER_NAME, Env:FORGE_EMBEDDING_MODEL, Env:FORGE_EMBEDDING_PROFILE_KEY, Env:FORGE_EMBEDDING_DIMENSIONS, Env:FORGE_EMBEDDING_QUERY_PREFIX -ErrorAction SilentlyContinue
}
