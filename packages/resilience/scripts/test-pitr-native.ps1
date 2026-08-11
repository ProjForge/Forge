[CmdletBinding()]
param(
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [switch]$KeepOnFailure
)

$ErrorActionPreference = 'Stop'
$initdb = Join-Path $PostgresBin 'initdb.exe'
$pgCtl = Join-Path $PostgresBin 'pg_ctl.exe'
$psql = Join-Path $PostgresBin 'psql.exe'
$pgBaseBackup = Join-Path $PostgresBin 'pg_basebackup.exe'
$pgVerifyBackup = Join-Path $PostgresBin 'pg_verifybackup.exe'
foreach ($tool in $initdb,$pgCtl,$psql,$pgBaseBackup,$pgVerifyBackup) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Required PostgreSQL tool not found: $tool" }
}

$workspaceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$statusDirectory = Join-Path $workspaceRoot '.run'
$statusPath = Join-Path $statusDirectory 'pitr-native.json'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = [IO.Path]::GetFullPath((Join-Path $tempBase ('forge-pitr-' + [Guid]::NewGuid().ToString('N'))))
if (-not $root.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notmatch '^forge-pitr-[a-f0-9]{32}$') {
    throw 'Unsafe PITR temporary directory.'
}
$primary = Join-Path $root 'primary'
$baseBackup = Join-Path $root 'base-backup'
$recovery = Join-Path $root 'recovery'
$archive = Join-Path $root 'wal-archive'
$primaryLog = Join-Path $root 'primary.log'
$recoveryLog = Join-Path $root 'recovery.log'
$archiveScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'archive-wal.ps1')).Replace('\','/')
$restoreScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'restore-wal.ps1')).Replace('\','/')
$archiveForward = $archive.Replace('\','/')
$primaryPort = Get-Random -Minimum 61000 -Maximum 62000
$recoveryPort = Get-Random -Minimum 62000 -Maximum 63000
$user = 'forge_pitr_admin'
$primaryStarted = $false
$recoveryStarted = $false
$passed = $false

function Set-Status([string]$Status, [string]$Detail) {
    New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
    [ordered]@{ status = $Status; detail = $Detail; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}

function Invoke-Checked([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL tool failed with exit code ${LASTEXITCODE}: $Tool" }
}

function Invoke-Sql([int]$Port, [string]$Database, [string]$Sql, [switch]$Scalar) {
    $arguments = @('-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',[string]$Port,'-U',$user,'-d',$Database)
    if ($Scalar) { $arguments += @('-A','-t') }
    $arguments += @('-c',$Sql)
    $output = & $psql @arguments
    if ($LASTEXITCODE -ne 0) { throw "SQL failed with exit code $LASTEXITCODE." }
    if ($Scalar) { return (($output | Out-String).Trim()) }
    return $output
}

Set-Status 'RUNNING' 'Creating isolated PostgreSQL cluster and WAL archive.'
New-Item -ItemType Directory -Force -Path $root,$archive | Out-Null
try {
    Invoke-Checked $initdb @('-D',$primary,'-U',$user,'-A','trust','--no-locale','-E','UTF8')
    $archiveCommand = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$archiveScript`" -Source `"%p`" -FileName `"%f`" -ArchiveDirectory `"$archiveForward`""
    @(
        "listen_addresses = '127.0.0.1'"
        "port = $primaryPort"
        "wal_level = 'replica'"
        "archive_mode = 'on'"
        "archive_timeout = '5s'"
        "archive_command = '$($archiveCommand.Replace("'", "''"))'"
        "max_wal_senders = 4"
    ) | Add-Content -LiteralPath (Join-Path $primary 'postgresql.conf') -Encoding utf8
    Invoke-Checked $pgCtl @('-D',$primary,'-l',$primaryLog,'-w','start')
    $primaryStarted = $true
    Invoke-Sql $primaryPort 'postgres' 'CREATE DATABASE forge_pitr;'
    Invoke-Sql $primaryPort 'forge_pitr' "CREATE TABLE recovery_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO recovery_probe VALUES (1, 'safe');"

    Invoke-Checked $pgBaseBackup @('-h','127.0.0.1','-p',[string]$primaryPort,'-U',$user,'-D',$baseBackup,'-Fp','-X','stream','--checkpoint=fast','--manifest-checksums=SHA256','--no-password')
    Invoke-Checked $pgVerifyBackup @($baseBackup)
    Invoke-Sql $primaryPort 'forge_pitr' "SELECT pg_create_restore_point('forge_safe_point');"
    Invoke-Sql $primaryPort 'forge_pitr' "UPDATE recovery_probe SET value = 'damaged' WHERE id = 1; INSERT INTO recovery_probe VALUES (2, 'must-disappear');"
    $segment = Invoke-Sql $primaryPort 'forge_pitr' 'SELECT pg_walfile_name(pg_current_wal_lsn());' -Scalar
    Invoke-Sql $primaryPort 'forge_pitr' 'SELECT pg_switch_wal();'
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path -LiteralPath (Join-Path $archive $segment)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Path -LiteralPath (Join-Path $archive $segment))) {
        $archiver = Invoke-Sql $primaryPort 'forge_pitr' "SELECT json_build_object('failedCount', failed_count, 'lastFailedWal', last_failed_wal, 'lastFailedTime', last_failed_time, 'lastArchivedWal', last_archived_wal)::text FROM pg_stat_archiver;" -Scalar
        throw "Required WAL segment was not archived: $segment; pg_stat_archiver=$archiver"
    }

    Invoke-Checked $pgCtl @('-D',$primary,'-m','fast','-w','stop')
    $primaryStarted = $false
    New-Item -ItemType Directory -Force -Path $recovery | Out-Null
    Copy-Item -Path (Join-Path $baseBackup '*') -Destination $recovery -Recurse -Force
    $restoreCommand = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$restoreScript`" -FileName `"%f`" -Destination `"%p`" -ArchiveDirectory `"$archiveForward`""
    @(
        "port = $recoveryPort"
        "archive_mode = 'off'"
        "restore_command = '$($restoreCommand.Replace("'", "''"))'"
        "recovery_target_name = 'forge_safe_point'"
        "recovery_target_action = 'promote'"
    ) | Add-Content -LiteralPath (Join-Path $recovery 'postgresql.auto.conf') -Encoding utf8
    New-Item -ItemType File -Force -Path (Join-Path $recovery 'recovery.signal') | Out-Null
    Invoke-Checked $pgCtl @('-D',$recovery,'-l',$recoveryLog,'-w','start')
    $recoveryStarted = $true
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $recoveryState = Invoke-Sql $recoveryPort 'forge_pitr' 'SELECT pg_is_in_recovery();' -Scalar
        if ($recoveryState -eq 'f') { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if ($recoveryState -ne 'f') { throw 'Recovered cluster was not promoted.' }
    $rows = Invoke-Sql $recoveryPort 'forge_pitr' "SELECT json_agg(recovery_probe ORDER BY id)::text FROM recovery_probe;" -Scalar
    if ($rows -ne '[{"id":1,"value":"safe"}]') { throw "PITR result does not match the named restore point: $rows" }
    $passed = $true
    Set-Status 'PASS' 'Base backup SHA-256 verification, continuous WAL archive and named point-in-time recovery passed.'
}
catch {
    Set-Status 'FAIL' $_.Exception.Message
    throw
}
finally {
    if ($recoveryStarted) { & $pgCtl -D $recovery -m immediate -w stop | Out-Null }
    if ($primaryStarted) { & $pgCtl -D $primary -m immediate -w stop | Out-Null }
    if ($passed -or -not $KeepOnFailure) {
        if ($root.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $root) -match '^forge-pitr-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
