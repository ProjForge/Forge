[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot "forge-pitr-activation-$([Guid]::NewGuid().ToString('N'))"))
try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $data = Join-Path $root 'PostgreSQL Data'
    $pitr = Join-Path $root 'PITR Root'
    $runtime = Join-Path $root 'Program Data'
    New-Item -ItemType Directory -Force -Path $data,$pitr | Out-Null
    $before = @(Get-ChildItem -LiteralPath $root -Recurse -File).Count
    $json = & (Join-Path $PSScriptRoot 'activate-pitr-windows.ps1') -PlanOnly -PlanDataDirectory $data -PitrRoot $pitr -ArchiveRuntimeRoot $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Activation plan failed.' }
    $plan = $json | ConvertFrom-Json
    if ($plan.archiveMode -ne 'on' -or $plan.archiveTimeout -ne '1h') { throw 'Activation target settings are incorrect.' }
    if ($plan.archiveCommand -notmatch [regex]::Escape((Join-Path $runtime 'archive-wal.ps1')) -or $plan.archiveCommand -notmatch '"%p"' -or $plan.archiveCommand -notmatch '"%f"') {
        throw 'archive_command does not preserve required quoting and placeholders.'
    }
    if ($plan.steps.Count -lt 8 -or $plan.rollback -notmatch 'restore exact configuration') { throw 'Activation plan is missing gates or rollback.' }
    $after = @(Get-ChildItem -LiteralPath $root -Recurse -File).Count
    if ($before -ne $after) { throw 'PlanOnly mutated the test environment.' }
    Write-Output 'PASS: PITR activation plan preserves quoting, gates, rollback and performs no mutation.'
}
finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
