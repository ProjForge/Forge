[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot "forge-physical-worker-$([Guid]::NewGuid().ToString('N'))"))
if (-not $root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary test root.' }
$config = Join-Path $root 'config'
$pitr = Join-Path $root 'pitr'
$packageRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $packageRoot)
$node = (Get-Command node.exe -ErrorAction Stop).Source
$cli = Join-Path $packageRoot 'dist\cli.js'
$plain = $null
$protected = $null
try {
    New-Item -ItemType Directory -Force -Path $config,(Join-Path $pitr 'wal') | Out-Null
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $plain = [Text.Encoding]::UTF8.GetBytes('physical-worker-test-passphrase-0123456789')
    $protected = [Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Convert]::ToBase64String($protected) | Set-Content -LiteralPath (Join-Path $config 'resilience-physical-passphrase.dpapi') -Encoding ascii
    [ordered]@{ nodePath=$node; cliPath=$cli } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config 'resilience-runtime.json') -Encoding utf8
    [ordered]@{
        cluster=[ordered]@{systemIdentifier='7548123456789012345';timeline=1;serverVersion='18.4';serverVersionNumber=180004}
        s3=[ordered]@{region='eu-west-1';target='unused'};policyPath=(Join-Path $config 'unused.json')
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Encoding utf8
    $wal = Join-Path (Join-Path $pitr 'wal') '000000010000000000000001'
    [IO.File]::WriteAllBytes($wal,(New-Object byte[] 4096))
    & (Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -PackageOnly | Out-Null
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status\physical-uploader.json') -Raw | ConvertFrom-Json
    if ($status.status -ne 'PASS' -or $status.results[0].status -ne 'packaged') { throw 'Package-only worker did not pass.' }
    & (Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -PackageOnly | Out-Null
    if (@(Get-ChildItem -LiteralPath (Join-Path $pitr 'encrypted') -Filter '*.forge-physical.json').Count -ne 1) { throw 'Worker replay was not idempotent.' }
    Write-Output 'PASS: physical uploader packages, verifies and replays WAL idempotently without AWS.'
}
finally {
    if ($plain) { [Array]::Clear($plain,0,$plain.Length) }
    if ($protected) { [Array]::Clear($protected,0,$protected.Length) }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
