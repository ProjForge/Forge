[CmdletBinding()]
param(
    [string]$HostName = '127.0.0.1',
    [int]$Port = 5432,
    [string]$MaintenanceDatabase = 'postgres',
    [string]$AdminRole = 'postgres',
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin'
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $packageRoot)
$statusDirectory = Join-Path $workspaceRoot '.run'
$statusPath = Join-Path $statusDirectory 'resilience-native.json'
$logPath = Join-Path $statusDirectory 'resilience-native.log'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$pointer = [IntPtr]::Zero
$password = $null
$exitCode = 1

New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null

function Set-DrillStatus {
    param([string]$Status, [string]$Detail)
    [pscustomobject]@{
        status = $Status
        detail = $Detail
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

Set-DrillStatus -Status 'RUNNING' -Detail 'Waiting for the PostgreSQL administrative password.'

try {
    $securePassword = Read-Host 'Enter the PostgreSQL administrative password for the isolated recovery drill' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $encodedPassword = [Uri]::EscapeDataString($password)
    $encodedDatabase = [Uri]::EscapeDataString($MaintenanceDatabase)
    $env:FORGE_TEST_ADMIN_DATABASE_URL = "postgresql://${AdminRole}:$encodedPassword@${HostName}:$Port/$encodedDatabase"
    $env:FORGE_POSTGRES_BIN = $PostgresBin

    Push-Location $packageRoot
    try {
        & $npm run test:integration 2>&1 | Tee-Object -FilePath $logPath
        if ($LASTEXITCODE -ne 0) { throw "Native recovery drill failed with exit code $LASTEXITCODE." }
        Set-DrillStatus -Status 'PASS' -Detail 'Encrypted backup, authentication, transactional restore and data verification passed.'
        $exitCode = 0
    }
    finally {
        Pop-Location
    }
}
catch {
    Set-DrillStatus -Status 'FAIL' -Detail $_.Exception.Message
    Write-Error $_
}
finally {
    Remove-Item Env:FORGE_TEST_ADMIN_DATABASE_URL,Env:FORGE_POSTGRES_BIN -ErrorAction SilentlyContinue
    $encodedPassword = $null
    $password = $null
    $securePassword = $null
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

exit $exitCode
