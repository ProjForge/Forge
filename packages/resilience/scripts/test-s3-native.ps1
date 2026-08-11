[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}\.forge-backup\.json$')][string]$ObjectManifest,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$TargetName = 'aws-offsite-worm',
    [string]$HostName = '127.0.0.1',
    [int]$Port = 5432,
    [string]$MaintenanceDatabase = 'postgres',
    [string]$AdminRole = 'postgres',
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [switch]$KeepDatabase
)

$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'OutputDirectory must be an absolute path.' }

$packageRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $packageRoot)
$statusDirectory = Join-Path $workspaceRoot '.run'
$statusPath = Join-Path $statusDirectory 'resilience-s3-native.json'
$runtimePath = Join-Path $ConfigRoot 'resilience-runtime.json'
$passphrasePath = Join-Path $ConfigRoot 'resilience-passphrase.dpapi'
$accessKeyPath = Join-Path $ConfigRoot 'resilience-aws-access-key-id.dpapi'
$secretKeyPath = Join-Path $ConfigRoot 'resilience-aws-secret-access-key.dpapi'
$databaseName = "forge_s3_drill_$([Guid]::NewGuid().ToString('N').Substring(0,12))"
$drillDirectory = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) $databaseName
$databaseCreated = $false
$exitCode = 1
$adminPointer = [IntPtr]::Zero
$adminPassword = $null
$protectedValues = @()
$plainValues = @()

New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
function Set-DrillStatus([string]$Status, [string]$Detail) {
    [ordered]@{
        status = $Status
        detail = $Detail
        database = $databaseName
        retained = [bool]$KeepDatabase
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}

function Read-DpapiSecret([string]$Path) {
    $protected = [Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $script:protectedValues += ,$protected
    $script:plainValues += ,$plain
    return [Text.Encoding]::UTF8.GetString($plain)
}

Set-DrillStatus 'RUNNING' 'Waiting for the PostgreSQL administrative password.'
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    $postgresBin = [string]$runtime.postgresBin
    $createdb = Join-Path $postgresBin 'createdb.exe'
    $dropdb = Join-Path $postgresBin 'dropdb.exe'
    if (-not (Test-Path -LiteralPath $createdb) -or -not (Test-Path -LiteralPath $dropdb)) {
        throw 'PostgreSQL createdb/dropdb tools were not found in the configured bin directory.'
    }

    $adminSecure = Read-Host 'PostgreSQL administrative password for the isolated AWS recovery drill' -AsSecureString
    $adminPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecure)
    $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPointer)
    $passphrase = Read-DpapiSecret $passphrasePath
    $awsAccessKey = Read-DpapiSecret $accessKeyPath
    $awsSecretKey = Read-DpapiSecret $secretKeyPath

    $env:FORGE_BACKUP_PASSPHRASE = $passphrase
    $env:AWS_ACCESS_KEY_ID = $awsAccessKey
    $env:AWS_SECRET_ACCESS_KEY = $awsSecretKey
    New-Item -ItemType Directory -Force -Path $drillDirectory | Out-Null
    $fetchOutput = & ([string]$runtime.nodePath) ([string]$runtime.cliPath) fetch-s3 `
        --config ([string]$runtime.policyPath) --target $TargetName `
        --object-manifest $ObjectManifest --output $drillDirectory
    if ($LASTEXITCODE -ne 0) { throw "S3 fetch failed with exit code $LASTEXITCODE." }
    $fetchResult = $fetchOutput | ConvertFrom-Json

    $env:PGPASSWORD = $adminPassword
    & $createdb --host $HostName --port $Port --username $AdminRole `
        --maintenance-db $MaintenanceDatabase $databaseName
    if ($LASTEXITCODE -ne 0) { throw "Could not create isolated recovery database (exit $LASTEXITCODE)." }
    $databaseCreated = $true

    $encodedRole = [Uri]::EscapeDataString($AdminRole)
    $encodedPassword = [Uri]::EscapeDataString($adminPassword)
    $encodedDatabase = [Uri]::EscapeDataString($databaseName)
    $env:FORGE_RESTORE_DATABASE_URL = "postgresql://${encodedRole}:${encodedPassword}@${HostName}:$Port/${encodedDatabase}"
    & ([string]$runtime.nodePath) ([string]$runtime.cliPath) restore `
        --manifest ([string]$fetchResult.manifestPath) --postgres-bin $postgresBin
    if ($LASTEXITCODE -ne 0) { throw "S3 recovery restore failed with exit code $LASTEXITCODE." }

    Set-DrillStatus 'PASS' 'Remote fetch, authentication and isolated PostgreSQL restore passed.'
    $exitCode = 0
}
catch {
    Set-DrillStatus 'FAIL' $_.Exception.Message
    Write-Error $_
}
finally {
    if ($databaseCreated -and -not $KeepDatabase) {
        & $dropdb --host $HostName --port $Port --username $AdminRole `
            --maintenance-db $MaintenanceDatabase --if-exists $databaseName
        if ($LASTEXITCODE -ne 0) {
            Set-DrillStatus 'FAIL' 'Restore passed, but isolated database cleanup failed.'
            $exitCode = 1
        }
    }
    Remove-Item Env:FORGE_BACKUP_PASSPHRASE,Env:AWS_ACCESS_KEY_ID,Env:AWS_SECRET_ACCESS_KEY,Env:FORGE_RESTORE_DATABASE_URL,Env:PGPASSWORD -ErrorAction SilentlyContinue
    $passphrase = $null
    $awsAccessKey = $null
    $awsSecretKey = $null
    $adminPassword = $null
    $adminSecure = $null
    $encodedPassword = $null
    if ($adminPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPointer) }
    foreach ($bytes in $plainValues) { if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) } }
    foreach ($bytes in $protectedValues) { if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) } }
}

exit $exitCode
