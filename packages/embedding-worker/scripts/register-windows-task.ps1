[CmdletBinding()]
param([switch]$Unregister)

$ErrorActionPreference = 'Stop'
$taskName = 'FORGE Embedding Worker'
$launcher = Join-Path $PSScriptRoot 'run-qwen-hidden.vbs'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Host "Removed scheduled task: $taskName"
    exit 0
}

$wscript = "$env:SystemRoot\System32\wscript.exe"
$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$launcher`""
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $periodicTrigger) -Settings $settings -Principal $principal -Description 'Incrementally indexes new FORGE knowledge every minute with the local Qwen embedding profile.' -Force | Out-Null
Write-Host "Registered scheduled task: $taskName"
