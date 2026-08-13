[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [string]$PostgresService = 'postgresql-x64-18',
    [ValidateRange(1,1024)][int]$MinimumFreeGiB = 20,
    [ValidateRange(1,99)][int]$MinimumFreePercent = 10,
    [ValidateRange(5,1440)][int]$WalReceiptMaxMinutes = 75,
    [ValidateRange(1,168)][int]$BaseReceiptMaxHours = 26,
    [string]$FixturePath,
    [datetime]$NowUtc = [datetime]::UtcNow
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PitrRoot)
$statusRoot = Join-Path $root 'status'
$statusPath = Join-Path $statusRoot 'pitr-monitor.json'
$checks = [Collections.Generic.List[object]]::new()
$protectedPassword = $null
$plainPassword = $null

function Add-Check([string]$Name,[string]$Status,[string]$Detail) {
    $checks.Add([ordered]@{name=$Name;status=$Status;detail=$Detail})
}
function Write-AtomicJson([string]$Path,[object]$Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
function Get-NewestReceipt([string]$Kind) {
    $receiptRoot = Join-Path $root 'receipts'
    if (-not (Test-Path -LiteralPath $receiptRoot -PathType Container)) { return $null }
    $records = foreach ($file in Get-ChildItem -LiteralPath $receiptRoot -Filter '*.receipt.json' -File) {
        try {
            $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $recordKind = if ($record.kind) { [string]$record.kind } elseif ($record.wal) { 'wal' } else { '' }
            if ($recordKind -eq $Kind -and $record.authenticatedAt) {
                [ordered]@{file=$file.Name;authenticatedAt=([datetime]$record.authenticatedAt).ToUniversalTime()}
            }
        } catch { Add-Check "receipt-$($file.Name)" 'FAIL' 'Receipt JSON is invalid.' }
    }
    return @($records | Sort-Object authenticatedAt -Descending | Select-Object -First 1)[0]
}

New-Item -ItemType Directory -Force -Path $statusRoot | Out-Null
$previous = $null
if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
    try { $previous = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { $previous = $null }
}
try {
    $physical = Get-Content -LiteralPath (Join-Path $ConfigRoot 'pitr-runtime.json') -Raw | ConvertFrom-Json
    $enabled = [bool]$physical.enabled
    if ($FixturePath) {
        $live = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
    } else {
        $runtime = Get-Content -LiteralPath (Join-Path $ConfigRoot 'resilience-runtime.json') -Raw | ConvertFrom-Json
        $service = Get-Service -Name $PostgresService -ErrorAction Stop
        $volumes = foreach ($drive in @('C',([IO.Path]::GetPathRoot($root).TrimEnd('\').TrimEnd(':')) | Select-Object -Unique)) {
            $volume = Get-Volume -DriveLetter $drive -ErrorAction Stop
            [ordered]@{drive=$drive;health=[string]$volume.HealthStatus;size=[int64]$volume.Size;free=[int64]$volume.SizeRemaining}
        }
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        $protectedPassword = [Convert]::FromBase64String((Get-Content -LiteralPath (Join-Path $ConfigRoot 'resilience-database.dpapi') -Raw).Trim())
        $plainPassword = [Security.Cryptography.ProtectedData]::Unprotect($protectedPassword,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $env:PGPASSWORD = [Text.Encoding]::UTF8.GetString($plainPassword)
        $psql = Join-Path ([string]$runtime.postgresBin) 'psql.exe'
        $sql = "SELECT json_build_object('archiveMode',current_setting('archive_mode'),'archiveTimeout',current_setting('archive_timeout'),'currentLsn',pg_current_wal_lsn()::text,'failedCount',failed_count,'lastArchivedWal',last_archived_wal,'lastFailedWal',last_failed_wal)::text FROM pg_stat_archiver;"
        $databaseJson = & $psql -X -A -t -v ON_ERROR_STOP=1 -h ([string]$runtime.database.host) -p ([string]$runtime.database.port) -U ([string]$runtime.database.user) -d ([string]$runtime.database.name) -c $sql
        if ($LASTEXITCODE -ne 0) { throw 'PITR monitor database query failed.' }
        $live = [ordered]@{serviceState=[string]$service.Status;volumes=@($volumes);database=(([string]$databaseJson).Trim() | ConvertFrom-Json)}
    }

    if ([string]$live.serviceState -eq 'Running') { Add-Check 'postgres-service' 'PASS' 'Service is running.' }
    else { Add-Check 'postgres-service' 'FAIL' "Service state is $($live.serviceState)." }
    foreach ($volume in @($live.volumes)) {
        $required = [Math]::Max(([int64]$MinimumFreeGiB * 1GB),([int64]$volume.size * $MinimumFreePercent / 100))
        if ([string]$volume.health -eq 'Healthy' -and [int64]$volume.free -ge $required) {
            Add-Check "capacity-$($volume.drive)" 'PASS' ("{0:N1} GiB free." -f ([int64]$volume.free / 1GB))
        } else { Add-Check "capacity-$($volume.drive)" 'FAIL' 'Volume is unhealthy or below its free-space gate.' }
    }

    $db = $live.database
    if (-not $enabled) {
        Add-Check 'activation' 'INFO' 'PITR is intentionally disabled; receipt-age and archive-mode gates are not enforced.'
        Add-Check 'archive-state' 'INFO' "archive_mode=$($db.archiveMode); archive_timeout=$($db.archiveTimeout)"
    } else {
        if ([string]$db.archiveMode -eq 'on' -and [string]$db.archiveTimeout -ne '0') { Add-Check 'archive-state' 'PASS' "archive_mode=on; archive_timeout=$($db.archiveTimeout)" }
        else { Add-Check 'archive-state' 'FAIL' "archive_mode=$($db.archiveMode); archive_timeout=$($db.archiveTimeout)" }
        $previousFailures = if ($previous -and $previous.database) { [int64]$previous.database.failedCount } else { [int64]$db.failedCount }
        if ([int64]$db.failedCount -le $previousFailures) { Add-Check 'archiver-failures' 'PASS' 'No new pg_stat_archiver failure.' }
        else { Add-Check 'archiver-failures' 'FAIL' "failed_count increased from $previousFailures to $($db.failedCount)." }

        $walReceipt = Get-NewestReceipt 'wal'
        $baseReceipt = Get-NewestReceipt 'base-backup'
        $activatedAt = ([datetime]$physical.activatedAt).ToUniversalTime()
        $walActivityAt = $null
        if ($previous -and $previous.walActivityAt) { $walActivityAt = ([datetime]$previous.walActivityAt).ToUniversalTime() }
        if ($previous -and $previous.database -and [string]$previous.database.currentLsn -ne [string]$db.currentLsn -and -not $walActivityAt) {
            $walActivityAt = $NowUtc.ToUniversalTime()
        }
        if ($walActivityAt -and $walReceipt -and $walReceipt.authenticatedAt -ge $walActivityAt) { $walActivityAt = $null }
        if (-not $walActivityAt) { Add-Check 'wal-receipt-age' 'PASS' 'No unauthenticated WAL activity is pending.' }
        elseif (($NowUtc.ToUniversalTime() - $walActivityAt).TotalMinutes -gt $WalReceiptMaxMinutes) { Add-Check 'wal-receipt-age' 'FAIL' 'WAL activity has remained without a later authenticated receipt beyond the RPO window.' }
        else { Add-Check 'wal-receipt-age' 'INFO' 'WAL activity is pending inside the authentication window.' }
        $baseRequired = ($NowUtc.ToUniversalTime() - $activatedAt).TotalHours -ge $BaseReceiptMaxHours
        if ($baseReceipt -and ($NowUtc.ToUniversalTime() - $baseReceipt.authenticatedAt).TotalHours -le $BaseReceiptMaxHours) { Add-Check 'base-receipt-age' 'PASS' 'A recent authenticated base-backup receipt exists.' }
        elseif ($baseRequired) { Add-Check 'base-receipt-age' 'FAIL' 'No authenticated base-backup receipt exists inside the daily window.' }
        else { Add-Check 'base-receipt-age' 'INFO' 'Initial base-backup grace period is still open.' }
    }

    $status = if (@($checks | Where-Object status -eq 'FAIL').Count -gt 0) { 'FAIL' } elseif ($enabled) { 'PASS' } else { 'PREACTIVATION' }
    $result = [ordered]@{status=$status;enabled=$enabled;checkedAt=$NowUtc.ToUniversalTime().ToString('o');walActivityAt=if($walActivityAt){$walActivityAt.ToString('o')}else{$null};database=$db;checks=$checks}
    Write-AtomicJson $statusPath $result
    $result | ConvertTo-Json -Depth 8
    if ($status -eq 'FAIL') { exit 2 }
    exit 0
}
catch {
    Write-AtomicJson $statusPath ([ordered]@{status='FAIL';checkedAt=$NowUtc.ToUniversalTime().ToString('o');error=$_.Exception.Message})
    throw
}
finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    if ($plainPassword) { [Array]::Clear($plainPassword,0,$plainPassword.Length) }
    if ($protectedPassword) { [Array]::Clear($protectedPassword,0,$protectedPassword.Length) }
}
