[CmdletBinding()]
param(
    [string]$HostName = '127.0.0.1',
    [int]$Port = 5432,
    [string]$Database = 'forge_test',
    [string]$RuntimeRole = 'forge_test_runner'
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$outputsRoot = Split-Path -Parent $packageRoot
$workspaceRoot = Split-Path -Parent $outputsRoot
$statusDirectory = Join-Path $workspaceRoot 'work'
$statusPath = Join-Path $statusDirectory 'forge-mcp-validation.json'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$exitCode = 1
$runtimePassword = $null
$encodedPassword = $null
$securePassword = $null
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

Set-ValidationStatus -Status 'RUNNING' -Detail 'Waiting for the runtime-role password.'

try {
    Write-Host ''
    Write-Host 'FORGE MCP: native stdio validation.' -ForegroundColor Cyan
    $securePassword = Read-Host "Enter the $RuntimeRole password" -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $runtimePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $encodedPassword = [Uri]::EscapeDataString($runtimePassword)
    $env:FORGE_DATABASE_URL = 'postgresql://{0}:{1}@{2}:{3}/{4}' -f $RuntimeRole, $encodedPassword, $HostName, $Port, $Database

    Push-Location $packageRoot
    try {
        & $npm run test:all
        if ($LASTEXITCODE -ne 0) {
            throw "MCP validation failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    Set-ValidationStatus -Status 'PASS' -Detail 'Build, unit contract and native stdio continuity passed.'
    Write-Host ''
    Write-Host 'PASS: FORGE MCP works end-to-end with forge_test_runner.' -ForegroundColor Green
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
