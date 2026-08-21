[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = Join-Path $tempRoot "forge-pitr-tasks-$([Guid]::NewGuid().ToString('N'))"
$config = Join-Path $root 'config'
$pitr = Join-Path $root 'pitr'
try {
    New-Item -ItemType Directory -Force -Path $config,$pitr | Out-Null
    $fixture = Join-Path $root 'hidden-fixture.ps1'
    $fixtureResult = Join-Path $root 'hidden-fixture-result.txt'
    @'
param([Parameter(Mandatory)][string]$OutputPath)
[IO.File]::WriteAllText($OutputPath, 'hidden-launcher-pass', [Text.UTF8Encoding]::new($false))
'@ | Set-Content -LiteralPath $fixture -Encoding utf8
    $hiddenLauncher = Join-Path $PSScriptRoot 'run-powershell-hidden.vbs'
    & "$env:SystemRoot\System32\cscript.exe" //B //NoLogo $hiddenLauncher $fixture '-OutputPath' $fixtureResult
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fixtureResult -PathType Leaf) -or (Get-Content -Raw -LiteralPath $fixtureResult) -ne 'hidden-launcher-pass') { throw "Invisible PowerShell launcher did not preserve arguments and exit status (exit=$LASTEXITCODE)." }
    foreach ($name in @('pitr-policy.json','resilience-replication.dpapi','resilience-physical-passphrase.dpapi')) { '{}' | Set-Content -LiteralPath (Join-Path $config $name) -Encoding ascii }
    [ordered]@{enabled=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Encoding utf8
    $json = & (Join-Path $PSScriptRoot 'install-pitr-tasks-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -IntervalMinutes 7 -DailyBaseTime '04:15' -PlanOnly
    $plan = $json | ConvertFrom-Json
    if ($plan.Count -ne 3) { throw 'PITR task plan does not contain exactly three workers.' }
    if ($plan[0].schedule -ne 'every-7-minutes-and-logon' -or $plan[1].schedule -ne 'daily-04:15') { throw 'PITR task schedules are incorrect.' }
    foreach ($item in $plan) {
        if ([IO.Path]::GetFileName($item.execute) -ne 'wscript.exe' -or $item.arguments -notmatch 'run-powershell-hidden\.vbs' -or $item.arguments -notmatch [regex]::Escape($config) -or $item.arguments -notmatch [regex]::Escape($pitr)) { throw "Unsafe or incomplete invisible task action: $($item.name)" }
    }
    [ordered]@{enabled=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Encoding utf8
    $failed = $false
    try { & (Join-Path $PSScriptRoot 'install-pitr-tasks-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -PlanOnly | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Installer did not reject post-activation task installation.' }
    $repairPlan = & (Join-Path $PSScriptRoot 'repair-hidden-task-actions-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -PlanOnly -Enable | ConvertFrom-Json
    if ($repairPlan.Count -ne 4) { throw 'Resilience action repair plan is incomplete.' }
    foreach ($item in $repairPlan) {
        if ([IO.Path]::GetFileName($item.execute) -ne 'wscript.exe' -or $item.arguments -notmatch 'run-powershell-hidden\.vbs' -or -not $item.enable) { throw "Unsafe resilience action repair: $($item.name)" }
    }
    Write-Output 'PASS: resilience task plans are limited, invisible, complete and keep post-activation repair explicit.'
}
finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
