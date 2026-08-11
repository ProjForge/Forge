$ErrorActionPreference = 'Stop'

$packageRoot = Split-Path -Parent $PSScriptRoot
$credentialPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE\forge_test_runner.dpapi'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$protectedBytes = $null
$passwordBytes = $null
$password = $null

try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $credentialPath)) {
        throw 'The FORGE DPAPI credential is not configured.'
    }
    $protectedBytes = [Convert]::FromBase64String(
        (Get-Content -Raw -LiteralPath $credentialPath).Trim()
    )
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
    $encodedPassword = [Uri]::EscapeDataString($password)
    $env:FORGE_DATABASE_URL = "postgresql://forge_test_runner:$encodedPassword@127.0.0.1:5432/forge_test"

    Push-Location $packageRoot
    try {
        & $npm run test:integration
        if ($LASTEXITCODE -ne 0) {
            throw "Embedding worker native integration failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
    $encodedPassword = $null
    $password = $null
    if ($null -ne $passwordBytes) {
        [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    }
    if ($null -ne $protectedBytes) {
        [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
    }
}
