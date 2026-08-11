[CmdletBinding()]
param([switch]$Continuous)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$forgeRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'
$credentialPath = Join-Path $forgeRoot 'forge_test_runner.dpapi'
$statusPath = Join-Path $forgeRoot 'embedding-worker-status.json'
$protectedBytes = $null
$passwordBytes = $null
$password = $null

try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $credentialPath)) { throw 'The FORGE DPAPI credential is not configured.' }
    $protectedBytes = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $credentialPath).Trim())
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
    $env:FORGE_DATABASE_URL = "postgresql://forge_test_runner:$([Uri]::EscapeDataString($password))@127.0.0.1:5432/forge_test"
    $env:FORGE_PROJECT_ID = 'bd726f08-4ccd-41c4-a861-8b7c5e7aec33'
    $env:FORGE_EMBEDDING_BASE_URL = 'http://127.0.0.1:1234/v1'
    $env:FORGE_EMBEDDING_PROVIDER_NAME = 'lmstudio-local'
    $env:FORGE_EMBEDDING_MODEL = 'text-embedding-qwen3-embedding-0.6b'
    $env:FORGE_EMBEDDING_PROFILE_KEY = 'qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1'
    $env:FORGE_EMBEDDING_DIMENSIONS = '1024'
    $env:FORGE_EMBEDDING_QUERY_PREFIX = "Instruct: Given a user question about a software project, retrieve the most relevant project decision or memory that answers the question`nQuery:"
    $env:FORGE_EMBEDDING_CONTINUOUS = $Continuous.IsPresent.ToString().ToLowerInvariant()
    $env:FORGE_EMBEDDING_POLL_INTERVAL_MS = '30000'
    $env:FORGE_EMBEDDING_ERROR_DELAY_MS = '15000'
    $env:FORGE_EMBEDDING_STATUS_FILE = $statusPath
    & (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $packageRoot 'dist\cli.js')
    exit $LASTEXITCODE
} finally {
    $password = $null
    if ($null -ne $passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
}
