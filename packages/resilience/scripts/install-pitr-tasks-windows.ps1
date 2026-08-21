[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [ValidateRange(1,60)][int]$IntervalMinutes = 5,
    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$DailyBaseTime = '03:00',
    [string]$TaskPrefix = 'FORGE PITR',
    [switch]$PlanOnly,
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$statusPath = Join-Path $ConfigRoot 'pitr-install-status.json'
$root = [IO.Path]::GetFullPath($PitrRoot)
$wscript = "$env:SystemRoot\System32\wscript.exe"
$hiddenLauncher = Join-Path $PSScriptRoot 'run-powershell-hidden.vbs'
$names = [ordered]@{
    uploader="$TaskPrefix WAL Uploader"
    base="$TaskPrefix Daily Base Backup"
    monitor="$TaskPrefix Monitor"
}
function Set-Status([string]$Status,[string]$Detail) {
    [ordered]@{status=$Status;detail=$Detail;updatedAt=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json |
        Set-Content -LiteralPath $statusPath -Encoding utf8
}
function Script-Arguments([string]$Script) {
    return "`"$hiddenLauncher`" `"$Script`" `"-ConfigRoot`" `"$ConfigRoot`" `"-PitrRoot`" `"$root`""
}

New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
if ($Unregister) {
    foreach ($name in $names.Values) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
    Set-Status 'REMOVED' 'PITR worker tasks were unregistered; PostgreSQL configuration was not changed.'
    return
}
foreach ($required in @('pitr-runtime.json','pitr-policy.json','resilience-replication.dpapi','resilience-physical-passphrase.dpapi')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ConfigRoot $required) -PathType Leaf)) { throw "Required PITR configuration is missing: $required" }
}
$runtime = Get-Content -LiteralPath (Join-Path $ConfigRoot 'pitr-runtime.json') -Raw | ConvertFrom-Json
if ([bool]$runtime.enabled) { throw 'Task installation must be completed before PITR activation.' }
$scripts = [ordered]@{
    uploader=Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1'
    base=Join-Path $PSScriptRoot 'run-physical-basebackup-windows.ps1'
    monitor=Join-Path $PSScriptRoot 'run-pitr-monitor-windows.ps1'
}
foreach ($script in @($hiddenLauncher) + @($scripts.Values)) { if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "Required worker script is missing: $script" } }
$plan = @(
    [ordered]@{name=$names.uploader;schedule="every-$IntervalMinutes-minutes-and-logon";execute=$wscript;arguments=(Script-Arguments $scripts.uploader)}
    [ordered]@{name=$names.base;schedule="daily-$DailyBaseTime";execute=$wscript;arguments=(Script-Arguments $scripts.base)}
    [ordered]@{name=$names.monitor;schedule="every-$IntervalMinutes-minutes-and-logon";execute=$wscript;arguments=(Script-Arguments $scripts.monitor)}
)
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 5; return }

Set-Status 'RUNNING' 'Registering limited-user PITR tasks while activation remains disabled.'
try {
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
    $dailyParts = $DailyBaseTime.Split(':')
    $dailyAt = (Get-Date).Date.AddHours([int]$dailyParts[0]).AddMinutes([int]$dailyParts[1])
    if ($dailyAt -le (Get-Date)) { $dailyAt = $dailyAt.AddDays(1) }
    $daily = New-ScheduledTaskTrigger -Daily -At $dailyAt
    $actions = [ordered]@{
        uploader=New-ScheduledTaskAction -Execute $wscript -Argument $plan[0].arguments
        base=New-ScheduledTaskAction -Execute $wscript -Argument $plan[1].arguments
        monitor=New-ScheduledTaskAction -Execute $wscript -Argument $plan[2].arguments
    }
    Register-ScheduledTask -TaskName $names.uploader -Action $actions.uploader -Trigger @($logon,$periodic) -Settings $settings -Principal $principal -Description 'Packages, verifies and remotely authenticates bounded FORGE WAL batches.' -Force | Out-Null
    Register-ScheduledTask -TaskName $names.base -Action $actions.base -Trigger $daily -Settings $settings -Principal $principal -Description 'Creates, verifies and remotely authenticates the daily FORGE physical base backup.' -Force | Out-Null
    Register-ScheduledTask -TaskName $names.monitor -Action $actions.monitor -Trigger @($logon,$periodic) -Settings $settings -Principal $principal -Description 'Fail-closed FORGE PITR service, capacity, archiver and receipt monitor.' -Force | Out-Null
    Set-Status 'PASS' 'Three limited-user PITR tasks are registered; activation remains disabled.'
    $plan | ConvertTo-Json -Depth 5
}
catch { Set-Status 'FAIL' $_.Exception.Message; throw }
