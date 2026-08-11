[CmdletBinding()]
param(
    [string]$HostName = '127.0.0.1',
    [int]$Port = 5432,
    [string]$Database = 'forge_test',
    [string]$AdminRole = 'postgres',
    [string]$BackupRole = 'forge_backup_reader',
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin'
)

$ErrorActionPreference = 'Stop'
$psql = Join-Path $PostgresBin 'psql.exe'
$sql = Join-Path $PSScriptRoot 'setup-backup-role.sql'
$workspaceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$statusDirectory = Join-Path $workspaceRoot '.run'
$statusPath = Join-Path $statusDirectory 'resilience-role-setup.json'
$logPath = Join-Path $statusDirectory 'resilience-role-setup.log'
if (-not (Test-Path -LiteralPath $psql)) { throw "psql was not found at $psql" }
if ($BackupRole -notmatch '^[a-z_][a-z0-9_]*$') { throw 'BackupRole is not a safe PostgreSQL identifier.' }

function Set-Status([string]$Status, [string]$Detail) {
    New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
    [ordered]@{ status = $Status; detail = $Detail; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}

Set-Status 'RUNNING' "Configuring $BackupRole on $Database."
try {
    & $psql -X -W -h $HostName -p $Port -U $AdminRole -d $Database `
        --set "backup_role=$BackupRole" -f $sql 2>&1 | Tee-Object -FilePath $logPath
    if ($LASTEXITCODE -ne 0) { throw "Backup role setup failed with exit code $LASTEXITCODE." }
    Set-Status 'PASS' "$BackupRole has read-only FORGE backup privileges on $Database."
    Write-Output "PASS: $BackupRole has read-only FORGE backup privileges on $Database."
}
catch {
    Set-Status 'FAIL' $_.Exception.Message
    throw
}
