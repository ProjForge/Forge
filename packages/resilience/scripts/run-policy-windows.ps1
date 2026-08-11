[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE')
)

$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $ConfigRoot 'resilience-runtime.json'
$databaseSecretPath = Join-Path $ConfigRoot 'resilience-database.dpapi'
$passphraseSecretPath = Join-Path $ConfigRoot 'resilience-passphrase.dpapi'
$awsAccessKeySecretPath = Join-Path $ConfigRoot 'resilience-aws-access-key-id.dpapi'
$awsSecretKeySecretPath = Join-Path $ConfigRoot 'resilience-aws-secret-access-key.dpapi'
$databaseProtected = $null
$passphraseProtected = $null
$databaseBytes = $null
$passphraseBytes = $null
$databasePassword = $null
$passphrase = $null
$awsAccessKeyProtected = $null
$awsSecretKeyProtected = $null
$awsAccessKeyBytes = $null
$awsSecretKeyBytes = $null
$awsAccessKey = $null
$awsSecretKey = $null

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
    $hasAwsAccessKey = Test-Path -LiteralPath $awsAccessKeySecretPath
    $hasAwsSecretKey = Test-Path -LiteralPath $awsSecretKeySecretPath
    if ($hasAwsAccessKey -xor $hasAwsSecretKey) { throw 'AWS recovery credential configuration is incomplete.' }
    if ($hasAwsAccessKey) {
        $awsAccessKeyProtected = [Convert]::FromBase64String((Get-Content -LiteralPath $awsAccessKeySecretPath -Raw).Trim())
        $awsSecretKeyProtected = [Convert]::FromBase64String((Get-Content -LiteralPath $awsSecretKeySecretPath -Raw).Trim())
        $awsAccessKeyBytes = [Security.Cryptography.ProtectedData]::Unprotect($awsAccessKeyProtected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $awsSecretKeyBytes = [Security.Cryptography.ProtectedData]::Unprotect($awsSecretKeyProtected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $awsAccessKey = [Text.Encoding]::UTF8.GetString($awsAccessKeyBytes)
        $awsSecretKey = [Text.Encoding]::UTF8.GetString($awsSecretKeyBytes)
        $env:AWS_ACCESS_KEY_ID = $awsAccessKey
        $env:AWS_SECRET_ACCESS_KEY = $awsSecretKey
    }
    & ([string]$runtime.nodePath) ([string]$runtime.cliPath) run-policy --config ([string]$runtime.policyPath)
    if ($LASTEXITCODE -ne 0) { throw "FORGE recovery policy failed with exit code $LASTEXITCODE." }
}
finally {
    Remove-Item Env:FORGE_DATABASE_URL,Env:FORGE_BACKUP_PASSPHRASE,Env:FORGE_POSTGRES_BIN,Env:AWS_ACCESS_KEY_ID,Env:AWS_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
    $databasePassword = $null
    $passphrase = $null
    $awsAccessKey = $null
    $awsSecretKey = $null
    if ($databaseBytes) { [Array]::Clear($databaseBytes,0,$databaseBytes.Length) }
    if ($passphraseBytes) { [Array]::Clear($passphraseBytes,0,$passphraseBytes.Length) }
    if ($databaseProtected) { [Array]::Clear($databaseProtected,0,$databaseProtected.Length) }
    if ($passphraseProtected) { [Array]::Clear($passphraseProtected,0,$passphraseProtected.Length) }
    if ($awsAccessKeyBytes) { [Array]::Clear($awsAccessKeyBytes,0,$awsAccessKeyBytes.Length) }
    if ($awsSecretKeyBytes) { [Array]::Clear($awsSecretKeyBytes,0,$awsSecretKeyBytes.Length) }
    if ($awsAccessKeyProtected) { [Array]::Clear($awsAccessKeyProtected,0,$awsAccessKeyProtected.Length) }
    if ($awsSecretKeyProtected) { [Array]::Clear($awsSecretKeyProtected,0,$awsSecretKeyProtected.Length) }
}
