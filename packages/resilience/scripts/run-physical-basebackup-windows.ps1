[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [string]$Label = ('base-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd')),
    [switch]$PackageOnly,
    [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
$runtime = Get-Content -LiteralPath (Join-Path $ConfigRoot 'resilience-runtime.json') -Raw | ConvertFrom-Json
$physical = Get-Content -LiteralPath (Join-Path $ConfigRoot 'pitr-runtime.json') -Raw | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($PitrRoot)
$stagingRoot = Join-Path $root 'staging'
$encryptedRoot = Join-Path $root 'encrypted'
$receiptRoot = Join-Path $root 'receipts'
$statusRoot = Join-Path $root 'status'
$manifestPath = Join-Path $encryptedRoot "$Label.forge-physical.json"
$receiptPath = Join-Path $receiptRoot "$Label.receipt.json"
$archivePath = Join-Path $stagingRoot "$Label.tar"
$protectedValues = [Collections.Generic.List[byte[]]]::new()
$plainValues = [Collections.Generic.List[byte[]]]::new()

if ($Label -notmatch '^base-[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$') { throw 'Base-backup label is unsafe.' }

function Read-Dpapi([string]$Path) {
    $protected = [Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $protectedValues.Add($protected)
    $plainValues.Add($plain)
    return [Text.Encoding]::UTF8.GetString($plain)
}

function Write-AtomicJson([string]$Path, [object]$Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $Value | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Invoke-NativeChecked([string]$Tool, [string[]]$Arguments, [string]$Failure) {
    $output = & $Tool @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$Failure $($output -join ' ')" }
}

New-Item -ItemType Directory -Force -Path $stagingRoot,$encryptedRoot,$receiptRoot,$statusRoot | Out-Null
$statusPath = Join-Path $statusRoot 'physical-basebackup.json'
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$backupDirectory = $null
$temporaryArchive = $null
$completed = $false
function Set-RunningPhase([string]$Phase) {
    Write-AtomicJson $statusPath ([ordered]@{ status='RUNNING'; phase=$Phase; startedAt=$startedAt; updatedAt=(Get-Date).ToUniversalTime().ToString('o') })
}
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
        $result = [ordered]@{ label=$Label; status='already-receipted'; receipt=$receiptPath }
    }
    else {
        $env:FORGE_BACKUP_PASSPHRASE = Read-Dpapi (Join-Path $ConfigRoot 'resilience-physical-passphrase.dpapi')
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            Set-RunningPhase 'base-backup'
            $postgresBin = [IO.Path]::GetFullPath([string]$physical.postgresBin)
            $pgBaseBackup = Join-Path $postgresBin 'pg_basebackup.exe'
            $pgVerifyBackup = Join-Path $postgresBin 'pg_verifybackup.exe'
            $tar = (Get-Command tar.exe -ErrorAction Stop).Source
            foreach ($tool in $pgBaseBackup,$pgVerifyBackup,$tar) {
                if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Required base-backup tool not found: $tool" }
            }
            $backupDirectory = Join-Path $stagingRoot "$Label-$([Guid]::NewGuid().ToString('N'))"
            $temporaryArchive = Join-Path $stagingRoot "$Label-$([Guid]::NewGuid().ToString('N')).partial.tar"
            $env:PGPASSWORD = Read-Dpapi (Join-Path $ConfigRoot 'resilience-replication.dpapi')
            $connection = $physical.replication
            Invoke-NativeChecked $pgBaseBackup @(
                '-h',[string]$connection.host,'-p',[string]$connection.port,'-U',[string]$connection.user,
                '-D',$backupDirectory,'-Fp','-X','stream','--checkpoint=fast',
                '--manifest-checksums=SHA256','--no-password'
            ) 'pg_basebackup failed.'
            Set-RunningPhase 'native-verification'
            Invoke-NativeChecked $pgVerifyBackup @('--exit-on-error',$backupDirectory) 'pg_verifybackup rejected the base backup.'
            Set-RunningPhase 'archive'
            Invoke-NativeChecked $tar @('-cf',$temporaryArchive,'-C',$backupDirectory,'.') 'Base-backup archive creation failed.'
            Move-Item -LiteralPath $temporaryArchive -Destination $archivePath
            $temporaryArchive = $null
            Set-RunningPhase 'encryption'
            & ([string]$runtime.nodePath) ([string]$runtime.cliPath) physical-pack `
                --kind base-backup --source $archivePath --output $encryptedRoot --label $Label `
                --system-identifier ([string]$physical.cluster.systemIdentifier) `
                --timeline ([string]$physical.cluster.timeline) `
                --server-version ([string]$physical.cluster.serverVersion) `
                --server-version-number ([string]$physical.cluster.serverVersionNumber) | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Physical base-backup packaging failed.' }
        }
        Set-RunningPhase 'package-verification'
        & ([string]$runtime.nodePath) ([string]$runtime.cliPath) physical-verify --manifest $manifestPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Physical base-backup verification failed.' }
        if ($PackageOnly) {
            $result = [ordered]@{ label=$Label; status='packaged'; manifest=$manifestPath }
        }
        else {
            Set-RunningPhase 'remote-authentication'
            $env:AWS_ACCESS_KEY_ID = Read-Dpapi (Join-Path $ConfigRoot 'resilience-aws-access-key-id.dpapi')
            $env:AWS_SECRET_ACCESS_KEY = Read-Dpapi (Join-Path $ConfigRoot 'resilience-aws-secret-access-key.dpapi')
            $env:AWS_REGION = [string]$physical.s3.region
            $upload = & ([string]$runtime.nodePath) ([string]$runtime.cliPath) physical-upload-s3 `
                --manifest $manifestPath --config ([string]$physical.policyPath) --target ([string]$physical.s3.target)
            if ($LASTEXITCODE -ne 0) { throw 'Physical base-backup upload failed.' }
            $remote = $upload | ConvertFrom-Json
            Write-AtomicJson $receiptPath ([ordered]@{
                format='forge-physical-receipt'; version=1; kind='base-backup'; label=$Label
                manifestLocation=$remote.manifestLocation; payloadLocation=$remote.payloadLocation
                authenticatedAt=(Get-Date).ToUniversalTime().ToString('o')
            })
            $result = [ordered]@{ label=$Label; status='authenticated'; receipt=$receiptPath }
        }
    }
    $completed = $true
    Write-AtomicJson $statusPath ([ordered]@{ status='PASS'; startedAt=$startedAt; completedAt=(Get-Date).ToUniversalTime().ToString('o'); packageOnly=[bool]$PackageOnly; result=$result })
    $result | ConvertTo-Json -Depth 6
}
catch {
    Write-AtomicJson $statusPath ([ordered]@{ status='FAIL'; startedAt=$startedAt; completedAt=(Get-Date).ToUniversalTime().ToString('o'); error=$_.Exception.Message })
    throw
}
finally {
    Remove-Item Env:PGPASSWORD,Env:FORGE_BACKUP_PASSPHRASE,Env:AWS_ACCESS_KEY_ID,Env:AWS_SECRET_ACCESS_KEY,Env:AWS_REGION -ErrorAction SilentlyContinue
    foreach ($plain in $plainValues) { [Array]::Clear($plain,0,$plain.Length) }
    foreach ($protected in $protectedValues) { [Array]::Clear($protected,0,$protected.Length) }
    if ($temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue }
    if ($completed -and -not $KeepStaging) {
        if ($backupDirectory) { Remove-Item -LiteralPath $backupDirectory -Recurse -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    }
}
