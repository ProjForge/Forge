[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE')
)

$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $ConfigRoot 'resilience-runtime.json'
$databaseSecretPath = Join-Path $ConfigRoot 'resilience-database.dpapi'
$passphraseSecretPath = Join-Path $ConfigRoot 'resilience-passphrase.dpapi'
$databaseProtected = $null
$passphraseProtected = $null
$databaseBytes = $null
$passphraseBytes = $null
$databasePassword = $null
$passphrase = $null

try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    $databaseProtected = [Convert]::FromBase64String((Get-Content -LiteralPath $databaseSecretPath -Raw).Trim())
    $passphraseProtected = [Convert]::FromBase64String((Get-Content -LiteralPath $passphraseSecretPath -Raw).Trim())
    $databaseBytes = [Security.Cryptography.ProtectedData]::Unprotect($databaseProtected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $passphraseBytes = [Security.Cryptography.ProtectedData]::Unprotect($passphraseProtected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $databasePassword = [Text.Encoding]::UTF8.GetString($databaseBytes)
    $passphrase = [Text.Encoding]::UTF8.GetString($passphraseBytes)
    $encodedUser = [Uri]::EscapeDataString([string]$runtime.database.user)
    $encodedPassword = [Uri]::EscapeDataString($databasePassword)
    $encodedDatabase = [Uri]::EscapeDataString([string]$runtime.database.name)
    $env:FORGE_DATABASE_URL = "postgresql://${encodedUser}:${encodedPassword}@$($runtime.database.host):$($runtime.database.port)/${encodedDatabase}"
    $env:FORGE_BACKUP_PASSPHRASE = $passphrase
    if ($runtime.postgresBin) { $env:FORGE_POSTGRES_BIN = [string]$runtime.postgresBin }
    & ([string]$runtime.nodePath) ([string]$runtime.cliPath) run-policy --config ([string]$runtime.policyPath)
    if ($LASTEXITCODE -ne 0) { throw "FORGE recovery policy failed with exit code $LASTEXITCODE." }
}
finally {
    Remove-Item Env:FORGE_DATABASE_URL,Env:FORGE_BACKUP_PASSPHRASE,Env:FORGE_POSTGRES_BIN -ErrorAction SilentlyContinue
    $databasePassword = $null
    $passphrase = $null
    if ($databaseBytes) { [Array]::Clear($databaseBytes,0,$databaseBytes.Length) }
    if ($passphraseBytes) { [Array]::Clear($passphraseBytes,0,$passphraseBytes.Length) }
    if ($databaseProtected) { [Array]::Clear($databaseProtected,0,$databaseProtected.Length) }
    if ($passphraseProtected) { [Array]::Clear($passphraseProtected,0,$passphraseProtected.Length) }
}
