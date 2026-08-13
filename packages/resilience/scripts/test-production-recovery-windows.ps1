[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [string]$BaseLabel = 'base-prod-acceptance-20260813',
    [switch]$KeepOnFailure
)

$ErrorActionPreference = 'Stop'
$runtime = Get-Content -LiteralPath (Join-Path $ConfigRoot 'resilience-runtime.json') -Raw | ConvertFrom-Json
$physical = Get-Content -LiteralPath (Join-Path $ConfigRoot 'pitr-runtime.json') -Raw | ConvertFrom-Json
$point = Get-Content -LiteralPath (Join-Path $ConfigRoot 'production-recovery-point.json') -Raw | ConvertFrom-Json
if ([string]$point.systemIdentifier -ne [string]$physical.cluster.systemIdentifier) { throw 'Recovery point belongs to a different PostgreSQL cluster.' }
if ([string]$point.name -notmatch '^forge_production_acceptance_[0-9]{8}_[0-9]{6}$' -or [string]$point.wal -notmatch '^[0-9A-F]{24}$') { throw 'Recovery point metadata is unsafe.' }

$postgresBin = [IO.Path]::GetFullPath([string]$physical.postgresBin)
$pgCtl = Join-Path $postgresBin 'pg_ctl.exe'
$pgVerifyBackup = Join-Path $postgresBin 'pg_verifybackup.exe'
$psql = Join-Path $postgresBin 'psql.exe'
$tar = (Get-Command tar.exe -ErrorAction Stop).Source
foreach ($tool in $pgCtl,$pgVerifyBackup,$psql,$tar,[string]$runtime.nodePath,[string]$runtime.cliPath) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Required recovery tool not found: $tool" }
}

$workspaceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$statusDirectory = Join-Path $workspaceRoot '.run'
$statusPath = Join-Path $statusDirectory 'production-recovery.json'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = [IO.Path]::GetFullPath((Join-Path $tempBase ('forge-production-recovery-' + [Guid]::NewGuid().ToString('N'))))
if (-not $root.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notmatch '^forge-production-recovery-[a-f0-9]{32}$') { throw 'Unsafe production-recovery temporary directory.' }
$download = Join-Path $root 'download'
$plaintext = Join-Path $root 'plaintext'
$archive = Join-Path $root 'wal-archive'
$recovery = Join-Path $root 'recovery'
$log = Join-Path $root 'postgresql.log'
$restoreScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'restore-wal.ps1')).Replace('\','/')
$archiveForward = $archive.Replace('\','/')
$recoveryPort = Get-Random -Minimum 63000 -Maximum 64000
$started = $false
$passed = $false
$protectedValues = [Collections.Generic.List[byte[]]]::new()
$plainValues = [Collections.Generic.List[byte[]]]::new()

function Read-Dpapi([string]$Path) {
    $protected = [Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $protectedValues.Add($protected); $plainValues.Add($plain)
    return [Text.Encoding]::UTF8.GetString($plain)
}
function Write-Status([string]$Status,[string]$Detail,[object]$Evidence=$null) {
    New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
    [ordered]@{status=$Status;detail=$Detail;updatedAt=(Get-Date).ToUniversalTime().ToString('o');evidence=$Evidence} |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
}
function Invoke-Resilience([string[]]$Arguments) {
    $output = & ([string]$runtime.nodePath) ([string]$runtime.cliPath) @Arguments
    if ($LASTEXITCODE -ne 0) { throw "FORGE resilience command failed: $($Arguments[0])" }
    return ($output | ConvertFrom-Json)
}
function Invoke-RecoverySql([string]$Sql,[switch]$Scalar) {
    $arguments = @('-X','-w','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',[string]$recoveryPort,'-U',[string]$runtime.database.user,'-d',[string]$point.database)
    if ($Scalar) { $arguments += @('-A','-t') }
    $output = $Sql | & $psql @arguments -f - 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Recovered-cluster SQL failed: $($output -join ' ')" }
    if ($Scalar) { return (($output | Out-String).Trim()) }
    return $output
}

Write-Status 'RUNNING' 'Downloading and authenticating the production base backup and WAL chain from AWS.'
New-Item -ItemType Directory -Force -Path $root,$download,$plaintext,$archive,$recovery | Out-Null
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $env:FORGE_BACKUP_PASSPHRASE = Read-Dpapi (Join-Path $ConfigRoot 'resilience-physical-passphrase.dpapi')
    $env:AWS_ACCESS_KEY_ID = Read-Dpapi (Join-Path $ConfigRoot 'resilience-aws-access-key-id.dpapi')
    $env:AWS_SECRET_ACCESS_KEY = Read-Dpapi (Join-Path $ConfigRoot 'resilience-aws-secret-access-key.dpapi')
    $env:AWS_REGION = [string]$physical.s3.region

    $receiptRoot = Join-Path ([IO.Path]::GetFullPath($PitrRoot)) 'receipts'
    $baseReceiptPath = Join-Path $receiptRoot "$BaseLabel.receipt.json"
    $baseReceipt = Get-Content -LiteralPath $baseReceiptPath -Raw | ConvertFrom-Json
    $baseManifestName = [IO.Path]::GetFileName(([Uri][string]$baseReceipt.manifestLocation).AbsolutePath)
    $baseFetched = Invoke-Resilience @('physical-fetch-s3','--object-manifest',$baseManifestName,'--output',$download,'--config',[string]$physical.policyPath,'--target',[string]$physical.s3.target)
    $baseRestored = Invoke-Resilience @('physical-restore','--manifest',[string]$baseFetched.manifestPath,'--output',$plaintext)
    if ([string]$baseRestored.manifest.kind -ne 'base-backup') { throw 'Selected AWS base package is not a base backup.' }

    $walReceipts = @(Get-ChildItem -LiteralPath $receiptRoot -Filter 'wal-*.receipt.json' -File | ForEach-Object {
        $document = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
        if ([string]$document.wal -le [string]$point.wal -and [datetime]$document.authenticatedAt -ge [datetime]$baseReceipt.authenticatedAt) { $document }
    } | Sort-Object wal)
    if (-not ($walReceipts | Where-Object { [string]$_.wal -eq [string]$point.wal })) { throw 'The named restore-point WAL has no authenticated AWS receipt.' }
    foreach ($receipt in $walReceipts) {
        $manifestName = [IO.Path]::GetFileName(([Uri][string]$receipt.manifestLocation).AbsolutePath)
        $fetched = Invoke-Resilience @('physical-fetch-s3','--object-manifest',$manifestName,'--output',$download,'--config',[string]$physical.policyPath,'--target',[string]$physical.s3.target)
        $restored = Invoke-Resilience @('physical-restore','--manifest',[string]$fetched.manifestPath,'--output',$archive)
        if ([string]$restored.manifest.kind -ne 'wal' -or [string]$restored.manifest.source.file -ne [string]$receipt.wal) { throw 'AWS WAL package identity does not match its receipt.' }
    }

    & $tar -xf ([string]$baseRestored.outputPath) -C $recovery
    if ($LASTEXITCODE -ne 0) { throw 'Base-backup archive extraction failed.' }
    & $pgVerifyBackup --exit-on-error $recovery
    if ($LASTEXITCODE -ne 0) { throw 'pg_verifybackup rejected the AWS-restored base backup.' }
    $restoreCommand = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$restoreScript`" -FileName `"%f`" -Destination `"%p`" -ArchiveDirectory `"$archiveForward`""
    @(
        "listen_addresses = '127.0.0.1'"
        "port = $recoveryPort"
        "archive_mode = 'off'"
        "archive_command = ''"
        "restore_command = '$($restoreCommand.Replace("'", "''"))'"
        "recovery_target_name = '$([string]$point.name)'"
        "recovery_target_action = 'promote'"
    ) | Add-Content -LiteralPath (Join-Path $recovery 'postgresql.auto.conf') -Encoding utf8
    New-Item -ItemType File -Force -Path (Join-Path $recovery 'recovery.signal') | Out-Null
    & $pgCtl -D $recovery -l $log -w start
    if ($LASTEXITCODE -ne 0) { throw "Isolated recovered PostgreSQL failed to start. Log: $log" }
    $started = $true
    $env:PGPASSWORD = Read-Dpapi (Join-Path $ConfigRoot 'resilience-database.dpapi')
    $deadline = (Get-Date).AddSeconds(60)
    do {
        try { $state = Invoke-RecoverySql 'SELECT pg_is_in_recovery();' -Scalar }
        catch { $state = $null }
        if ($state -eq 'f') { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if ($state -ne 'f') { throw 'The isolated cluster did not promote at the named restore point.' }
    $counts = Invoke-RecoverySql "SELECT json_build_object('projects',(SELECT count(*) FROM forge.projects),'memories',(SELECT count(*) FROM forge.memories))::text;" -Scalar | ConvertFrom-Json
    if ([int64]$counts.projects -ne [int64]$point.projects -or [int64]$counts.memories -ne [int64]$point.memories) {
        throw "Recovered FORGE counts differ from the named point: projects=$($counts.projects), memories=$($counts.memories)"
    }
    $passed = $true
    $evidence = [ordered]@{restorePoint=[string]$point.name;targetWal=[string]$point.wal;baseLabel=$BaseLabel;walPackages=$walReceipts.Count;projects=[int64]$counts.projects;memories=[int64]$counts.memories;isolatedPort=$recoveryPort;productionPort=[int]$runtime.database.port}
    Write-Status 'PASS' 'AWS base and WAL packages authenticated, PostgreSQL promoted at the named target, and FORGE rows matched.' $evidence
    $evidence | ConvertTo-Json -Depth 6
}
catch {
    Write-Status 'FAIL' $_.Exception.Message ([ordered]@{temporaryRoot=$root;log=$log})
    throw
}
finally {
    if ($started -and (Test-Path -LiteralPath (Join-Path $recovery 'postmaster.pid') -PathType Leaf)) { & $pgCtl -D $recovery -m immediate -w stop | Out-Null }
    Remove-Item Env:PGPASSWORD,Env:FORGE_BACKUP_PASSPHRASE,Env:AWS_ACCESS_KEY_ID,Env:AWS_SECRET_ACCESS_KEY,Env:AWS_REGION -ErrorAction SilentlyContinue
    foreach ($plain in $plainValues) { [Array]::Clear($plain,0,$plain.Length) }
    foreach ($protected in $protectedValues) { [Array]::Clear($protected,0,$protected.Length) }
    if ($passed -or -not $KeepOnFailure) {
        if ($root.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $root) -match '^forge-production-recovery-[a-f0-9]{32}$') { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
