[CmdletBinding()]
param(
    [string]$HostName = '127.0.0.1',
    [int]$Port = 5432,
    [string]$Database = 'forge_test',
    [string]$AdminRole = 'postgres'
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$outputsRoot = Split-Path -Parent $packageRoot
$workspaceRoot = Split-Path -Parent $outputsRoot
$statusDirectory = Join-Path $workspaceRoot 'work'
$statusPath = Join-Path $statusDirectory 'forge-vector-runtime-grants.json'
$grantSql = Join-Path $PSScriptRoot 'grant-vector-runtime.sql'
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$exitCode = 1

New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null

function Set-GrantStatus {
    param(
        [string]$Status,
        [string]$Detail
    )

    [pscustomobject]@{
        status = $Status
        detail = $Detail
        updated_at = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

Set-GrantStatus -Status 'RUNNING' -Detail 'Waiting for PostgreSQL administrator authentication.'

try {
    if (-not (Test-Path -LiteralPath $psql)) {
        throw "psql was not found at $psql"
    }

    Write-Host ''
    Write-Host 'FORGE: applying vector privileges to forge_test_runner.' -ForegroundColor Cyan
    Write-Host 'Enter the postgres password. No password will be stored.'
    Write-Host ''

    $psqlOutput = & $psql -X -W -h $HostName -p $Port -U $AdminRole -d $Database -f $grantSql 2>&1
    $psqlExitCode = $LASTEXITCODE
    $psqlOutput | ForEach-Object { Write-Host $_ }
    if ($psqlExitCode -ne 0) {
        throw "Vector grant setup failed: $($psqlOutput -join ' ')"
    }

    Set-GrantStatus -Status 'PASS' -Detail 'Least-privilege vector grants applied.'
    Write-Host ''
    Write-Host 'PASS: vector grants applied; no password or schema objects changed.' -ForegroundColor Green
    $exitCode = 0
}
catch {
    Set-GrantStatus -Status 'FAIL' -Detail $_.Exception.Message
    Write-Host ''
    Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
Read-Host 'Press Enter to close this window'
exit $exitCode
