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
    # A full batch of historical receipts must not starve later pending WAL.
    $receipts = Join-Path $pitr 'receipts'
    New-Item -ItemType Directory -Force -Path $receipts | Out-Null
    foreach ($n in 1..18) {
        $name = '0000000100000000{0:X8}' -f $n
        [IO.File]::WriteAllBytes((Join-Path (Join-Path $pitr 'wal') $name),(New-Object byte[] 4096))
        if ($n -le 16) { '{}' | Set-Content -LiteralPath (Join-Path $receipts "wal-$name.receipt.json") }
    }
    & (Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -MaxItems 1 -PackageOnly | Out-Null
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status/physical-uploader.json') -Raw | ConvertFrom-Json
    if ($status.results[0].wal -ne '000000010000000000000011' -or $status.pendingCount -ne 2 -or -not $status.oldestPendingAt) { throw 'Receipted history starved the next batch or queue metadata is incorrect.' }
    '{}' | Set-Content -LiteralPath (Join-Path $receipts 'wal-000000010000000000000011.receipt.json')
    & (Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -MaxItems 1 -PackageOnly | Out-Null
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status/physical-uploader.json') -Raw | ConvertFrom-Json
    if ($status.results[0].wal -ne '000000010000000000000012') { throw 'Second batch did not advance.' }
    # Simulate remote transport, preserving the first receipt when the second item fails.
    $fakeCli = Join-Path $root 'fake-cli.mjs'
    @'
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const manifest = process.argv[process.argv.indexOf('--manifest') + 1] || '';
if (process.argv.includes('physical-upload-s3')) {
  if (existsSync(join(import.meta.dirname, 'fail')) && manifest.includes('00000012')) process.exit(1);
  console.log(JSON.stringify({ manifestLocation: 'fake://manifest', payloadLocation: 'fake://payload' }));
}
'@ | Set-Content -LiteralPath $fakeCli -Encoding utf8
    [ordered]@{nodePath=$node;cliPath=$fakeCli}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $config 'resilience-runtime.json') -Encoding utf8
    foreach ($key in @('resilience-aws-access-key-id.dpapi','resilience-aws-secret-access-key.dpapi')) {
        [Convert]::ToBase64String($protected) | Set-Content -LiteralPath (Join-Path $config $key) -Encoding ascii
    }
    Remove-Item -LiteralPath (Join-Path $receipts 'wal-000000010000000000000011.receipt.json')
    'fail' | Set-Content -LiteralPath (Join-Path $root 'fail')
    $failed = $false
    try { & (Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -MaxItems 2 | Out-Null } catch { $failed=$true }
    if (-not $failed) { throw 'Transport failure was hidden.' }
    $firstReceipt = Join-Path $receipts 'wal-000000010000000000000011.receipt.json'
    $before = Get-Content -LiteralPath $firstReceipt -Raw
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status/physical-uploader.json') -Raw | ConvertFrom-Json
    if ($status.status -ne 'FAIL' -or $status.pendingCount -ne 1) { throw 'Partial failure lost progress or queue state.' }
    Remove-Item -LiteralPath (Join-Path $root 'fail')
    & (Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -MaxItems 2 | Out-Null
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status/physical-uploader.json') -Raw | ConvertFrom-Json
    if ($status.pendingCount -ne 0 -or $null -ne $status.oldestPendingAt -or (Get-Content -LiteralPath $firstReceipt -Raw) -ne $before) { throw 'Resume failed or rewrote a receipt.' }
    Write-Output 'PASS: WAL batches advance past old receipts, preserve progress after transport failure and resume idempotently without AWS.'
}
finally {
    if ($plain) { [Array]::Clear($plain,0,$plain.Length) }
    if ($protected) { [Array]::Clear($protected,0,$protected.Length) }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
