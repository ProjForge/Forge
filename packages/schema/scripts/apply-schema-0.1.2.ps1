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
$statusPath = Join-Path $statusDirectory 'forge-schema-0.1.2-migration.json'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$passwordPointer = [IntPtr]::Zero
$adminPassword = $null
$exitCode = 1

New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null

function Set-MigrationStatus {
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

Set-MigrationStatus -Status 'RUNNING' -Detail 'Waiting for PostgreSQL administrator authentication.'

try {
    Write-Host ''
    Write-Host 'FORGE: applying Schema 0.1.2 with checksum tracking.' -ForegroundColor Cyan
    $securePassword = Read-Host 'Enter the postgres password' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $encodedPassword = [Uri]::EscapeDataString($adminPassword)
    $env:FORGE_DATABASE_URL = 'postgresql://{0}:{1}@{2}:{3}/{4}' -f $AdminRole, $encodedPassword, $HostName, $Port, $Database

    Push-Location $packageRoot
    try {
        & $npm run migrate
        if ($LASTEXITCODE -ne 0) {
            throw "Schema migration failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    Set-MigrationStatus -Status 'PASS' -Detail 'Schema 0.1.2 migration applied with checksum tracking.'
    Write-Host ''
    Write-Host 'PASS: Schema 0.1.2 applied.' -ForegroundColor Green
    $exitCode = 0
}
catch {
    Set-MigrationStatus -Status 'FAIL' -Detail $_.Exception.Message
    Write-Host ''
    Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
    $encodedPassword = $null
    $adminPassword = $null
    $securePassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

Write-Host ''
Read-Host 'Press Enter to close this window'
exit $exitCode
