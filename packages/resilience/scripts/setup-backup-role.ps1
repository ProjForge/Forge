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
if (-not (Test-Path -LiteralPath $psql)) { throw "psql was not found at $psql" }
if ($BackupRole -notmatch '^[a-z_][a-z0-9_]*$') { throw 'BackupRole is not a safe PostgreSQL identifier.' }

& $psql -X -W -h $HostName -p $Port -U $AdminRole -d $Database `
    --set "backup_role=$BackupRole" -f $sql
if ($LASTEXITCODE -ne 0) { throw "Backup role setup failed with exit code $LASTEXITCODE." }

Write-Output "PASS: $BackupRole has read-only FORGE backup privileges on $Database."
