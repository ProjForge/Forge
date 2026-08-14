[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'compatibility\test-tencentdb.ps1'
$tokens = $null
$errors = $null
[Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$errors) | Out-Null
if ($errors.Count -gt 0) {
    $messages = $errors | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }
    throw "TencentDB wrapper failed PowerShell syntax validation: $($messages -join '; ')"
}
$source = Get-Content -LiteralPath $scriptPath -Raw
foreach ($required in @(
    "Read-Host 'TencentDB administrative PostgreSQL URL",
    "Read-Host 'New ephemeral FORGE runtime password",
    'SecureStringToBSTR',
    'ZeroFreeBSTR',
    'Remove-Item Env:FORGE_TENCENTDB_ADMIN_URL',
    "node_modules\npm\bin\npm-cli.js"
)) {
    if (-not $source.Contains($required)) { throw "TencentDB wrapper is missing safety behavior: $required" }
}
if ($source -match '(?i)postgres(?:ql)?://[^\s''"]+:[^@\s''"]+@') {
    throw 'TencentDB wrapper contains a hardcoded PostgreSQL credential.'
}
Write-Output 'PASS: TencentDB PowerShell wrapper parses and preserves its secret lifecycle.'
