[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = Join-Path $tempRoot "forge-pitr-tasks-$([Guid]::NewGuid().ToString('N'))"
$config = Join-Path $root 'config'
$pitr = Join-Path $root 'pitr'
try {
    New-Item -ItemType Directory -Force -Path $config,$pitr | Out-Null
    foreach ($name in @('pitr-policy.json','resilience-replication.dpapi','resilience-physical-passphrase.dpapi')) { '{}' | Set-Content -LiteralPath (Join-Path $config $name) -Encoding ascii }
    [ordered]@{enabled=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Encoding utf8
    $json = & (Join-Path $PSScriptRoot 'install-pitr-tasks-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -IntervalMinutes 7 -DailyBaseTime '04:15' -PlanOnly
    $plan = $json | ConvertFrom-Json
    if ($plan.Count -ne 3) { throw 'PITR task plan does not contain exactly three workers.' }
    if ($plan[0].schedule -ne 'every-7-minutes-and-logon' -or $plan[1].schedule -ne 'daily-04:15') { throw 'PITR task schedules are incorrect.' }
    foreach ($item in $plan) {
        if ($item.arguments -notmatch '-NoProfile -NonInteractive' -or $item.arguments -notmatch '-WindowStyle Hidden' -or $item.arguments -notmatch [regex]::Escape($config) -or $item.arguments -notmatch [regex]::Escape($pitr)) { throw "Unsafe or incomplete task arguments: $($item.name)" }
    }
    [ordered]@{enabled=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Encoding utf8
    $failed = $false
    try { & (Join-Path $PSScriptRoot 'install-pitr-tasks-windows.ps1') -ConfigRoot $config -PitrRoot $pitr -PlanOnly | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Installer did not reject post-activation task installation.' }
    Write-Output 'PASS: PITR task plan is limited, hidden, complete and refuses post-activation installation.'
}
finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
