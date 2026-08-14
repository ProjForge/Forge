[CmdletBinding()]
param(
    [string]$RunId = ('local_' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$adminPointer = [IntPtr]::Zero
$runtimePointer = [IntPtr]::Zero
$adminUrl = $null
$runtimePassword = $null

try {
    $adminSecure = Read-Host 'TencentDB administrative PostgreSQL URL (must include sslmode=verify-full)' -AsSecureString
    $runtimeSecure = Read-Host 'New ephemeral FORGE runtime password (12+ characters)' -AsSecureString
    $adminPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecure)
    $runtimePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($runtimeSecure)
    $adminUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPointer)
    $runtimePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($runtimePointer)

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $npmCli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'The npm CLI adjacent to node.exe was not found.' }

    $env:FORGE_TENCENTDB_ADMIN_URL = $adminUrl
    $env:FORGE_TENCENTDB_RUNTIME_PASSWORD = $runtimePassword
    $env:FORGE_TENCENTDB_RUN_ID = $RunId
    & $node $npmCli run test:compat:tencentdb
    if ($LASTEXITCODE -ne 0) { throw "TencentDB compatibility gate failed with exit code $LASTEXITCODE." }
}
finally {
    Remove-Item Env:FORGE_TENCENTDB_ADMIN_URL,Env:FORGE_TENCENTDB_RUNTIME_PASSWORD,Env:FORGE_TENCENTDB_RUN_ID -ErrorAction SilentlyContinue
    $adminUrl = $null
    $runtimePassword = $null
    if ($adminPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPointer) }
    if ($runtimePointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($runtimePointer) }
}
