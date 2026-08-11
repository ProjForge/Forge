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
$statusPath = Join-Path $statusDirectory 'forge-runtime-role-validation.json'
$gatewayRoot = Join-Path $outputsRoot 'forge-persistence-gateway-0.1'
$setupSql = Join-Path $PSScriptRoot 'setup-runtime-role.sql'
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$exitCode = 1
$runtimePassword = $null
$passwordPointer = [IntPtr]::Zero

New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null

function Set-ValidationStatus {
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

function Assert-LastExitCode {
    param([string]$Step)

    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

Set-ValidationStatus -Status 'RUNNING' -Detail 'Waiting for interactive PostgreSQL setup.'

try {
    if (-not (Test-Path -LiteralPath $psql)) {
        throw "psql was not found at $psql"
    }
    if (-not (Test-Path -LiteralPath $gatewayRoot)) {
        throw "Gateway package was not found at $gatewayRoot"
    }

    Write-Host ''
    Write-Host 'FORGE: configuring forge_test_runner with least privilege.' -ForegroundColor Cyan
    Write-Host 'First enter the postgres password. Then choose the runtime password twice.'
    Write-Host ''

    & $psql -X -W -h $HostName -p $Port -U $AdminRole -d $Database -f $setupSql
    Assert-LastExitCode 'Runtime role setup'

    Write-Host ''
    $securePassword = Read-Host 'Enter the forge_test_runner password once more to run validation' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $runtimePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $encodedPassword = [Uri]::EscapeDataString($runtimePassword)
    $env:FORGE_DATABASE_URL = 'postgresql://forge_test_runner:{0}@{1}:{2}/{3}' -f $encodedPassword, $HostName, $Port, $Database

    Push-Location $packageRoot
    try {
        & $npm run test:runtime-role
        Assert-LastExitCode 'Runtime role permission test'
    }
    finally {
        Pop-Location
    }

    Push-Location $gatewayRoot
    try {
        & $npm run test:all
        Assert-LastExitCode 'Gateway test suite'
        & $npm run smoke
        Assert-LastExitCode 'Gateway smoke flow'
    }
    finally {
        Pop-Location
    }

    Set-ValidationStatus -Status 'PASS' -Detail 'Least-privilege role, Gateway integration and smoke validation passed.'
    Write-Host ''
    Write-Host 'PASS: forge_test_runner is configured and FORGE works without postgres.' -ForegroundColor Green
    $exitCode = 0
}
catch {
    Set-ValidationStatus -Status 'FAIL' -Detail $_.Exception.Message
    Write-Host ''
    Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
    $encodedPassword = $null
    $runtimePassword = $null
    $securePassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

Write-Host ''
Read-Host 'Press Enter to close this window'
exit $exitCode
