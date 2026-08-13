[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot "forge-pitr-monitor-$([Guid]::NewGuid().ToString('N'))"))
if (-not $root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notmatch '^forge-pitr-monitor-[a-f0-9]{32}$') { throw 'Unsafe monitor test root.' }
$config = Join-Path $root 'config'
$pitr = Join-Path $root 'pitr'
$receiptRoot = Join-Path $pitr 'receipts'
$fixturePath = Join-Path $root 'fixture.json'
$now = [datetime]'2026-08-13T20:00:00Z'

function Set-Runtime([bool]$Enabled,[datetime]$ActivatedAt) {
    [ordered]@{enabled=$Enabled;activatedAt=$ActivatedAt.ToUniversalTime().ToString('o')} | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Encoding utf8
}
function Set-Fixture([int64]$FailedCount,[int64]$EFree,[string]$CurrentLsn='0/1000000') {
    [ordered]@{
        serviceState='Running'
        volumes=@(
            [ordered]@{drive='C';health='Healthy';size=500GB;free=100GB},
            [ordered]@{drive='E';health='Healthy';size=500GB;free=$EFree}
        )
        database=[ordered]@{archiveMode='on';archiveTimeout='1h';currentLsn=$CurrentLsn;failedCount=$FailedCount;lastArchivedWal='000000010000000000000001';lastFailedWal=$null}
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $fixturePath -Encoding utf8
}
function Write-Receipt([string]$Name,[string]$Kind,[datetime]$Time) {
    [ordered]@{format='forge-physical-receipt';version=1;kind=$Kind;authenticatedAt=$Time.ToUniversalTime().ToString('o')} | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $receiptRoot "$Name.receipt.json") -Encoding utf8
}
function Invoke-Monitor {
    & (Join-Path $PSScriptRoot 'run-pitr-monitor-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -FixturePath $fixturePath -NowUtc $now | Out-Null
    return $LASTEXITCODE
}

try {
    New-Item -ItemType Directory -Force -Path $config,$receiptRoot | Out-Null
    Set-Runtime $false $now
    Set-Fixture 0 100GB
    if ((Invoke-Monitor) -ne 0) { throw 'Preactivation monitor unexpectedly failed.' }
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status\pitr-monitor.json') -Raw | ConvertFrom-Json
    if ($status.status -ne 'PREACTIVATION' -or @($status.checks | Where-Object status -eq 'FAIL').Count -ne 0) { throw 'Preactivation gates are incorrect.' }
    $status.checkedAt = $now.AddMinutes(-20).ToString('o')
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $pitr 'status\pitr-monitor.json') -Encoding utf8

    Set-Runtime $true $now.AddHours(-2)
    Set-Fixture 0 100GB '0/2000000'
    Write-Receipt 'wal-recent' 'wal' $now.AddMinutes(-10)
    Write-Receipt 'base-recent' 'base-backup' $now.AddHours(-2)
    if ((Invoke-Monitor) -ne 0) { throw 'Healthy activated monitor unexpectedly failed.' }
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status\pitr-monitor.json') -Raw | ConvertFrom-Json
    $walCheck = @($status.checks | Where-Object name -eq 'wal-receipt-age')[0]
    if ($status.status -ne 'PASS' -or $walCheck.status -ne 'PASS' -or $status.walActivityAt) { throw 'Activated monitor did not clear activity authenticated between checks.' }

    Set-Runtime $true $now.AddHours(-30)
    $status.walActivityAt = $now.AddMinutes(-80).ToString('o')
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $pitr 'status\pitr-monitor.json') -Encoding utf8
    Get-ChildItem -LiteralPath $receiptRoot -Filter '*.receipt.json' -File | Remove-Item -Force
    Write-Receipt 'wal-stale' 'wal' $now.AddMinutes(-90)
    Write-Receipt 'base-stale' 'base-backup' $now.AddHours(-27)
    Set-Fixture 1 5GB '0/3000000'
    if ((Invoke-Monitor) -ne 2) { throw 'Fail-closed monitor did not return exit code 2.' }
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status\pitr-monitor.json') -Raw | ConvertFrom-Json
    $failures = @($status.checks | Where-Object status -eq 'FAIL' | Select-Object -ExpandProperty name)
    foreach ($expected in @('capacity-E','archiver-failures','wal-receipt-age','base-receipt-age')) {
        if ($expected -notin $failures) { throw "Missing expected monitor failure: $expected" }
    }
    Write-Output 'PASS: PITR monitor distinguishes preactivation, healthy operation and fail-closed capacity/archiver/receipt conditions.'
}
finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
