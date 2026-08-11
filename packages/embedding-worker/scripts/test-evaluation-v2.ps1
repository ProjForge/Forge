$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE\forge_test_runner.dpapi'
$protectedBytes = $null; $passwordBytes = $null; $password = $null
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $protectedBytes = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $credentialPath).Trim())
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
    $env:FORGE_DATABASE_URL = "postgresql://forge_test_runner:$([Uri]::EscapeDataString($password))@127.0.0.1:5432/forge_test"
    npm run eval:multilingual-v2
    if ($LASTEXITCODE -ne 0) { throw "Evaluation failed with exit code $LASTEXITCODE" }
} finally {
    $password = $null
    if ($null -ne $passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
}
