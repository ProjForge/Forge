[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [string]$TaskPrefix = 'FORGE PITR',
    [string]$LogicalTaskName = 'FORGE Verified Recovery Backup',
    [switch]$PlanOnly,
    [switch]$Enable
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PitrRoot)
$wscript = "$env:SystemRoot\System32\wscript.exe"
$hiddenLauncher = Join-Path $PSScriptRoot 'run-powershell-hidden.vbs'
$statusPath = Join-Path $ConfigRoot 'resilience-task-repair-status.json'

function Hidden-Arguments([string]$Script, [string[]]$Arguments) {
    $parts = @("`"$hiddenLauncher`"", "`"$Script`"")
    $parts += $Arguments | ForEach-Object { "`"$_`"" }
    return $parts -join ' '
}
function Set-RepairStatus([string]$Status, [string]$Detail) {
    New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
    [ordered]@{status=$Status;detail=$Detail;updatedAt=[datetime]::UtcNow.ToString('o')} |
        ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}

$workers = @(
    [ordered]@{name="$TaskPrefix WAL Uploader";script=(Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1');arguments=@('-ConfigRoot',$ConfigRoot,'-PitrRoot',$root)}
    [ordered]@{name="$TaskPrefix Daily Base Backup";script=(Join-Path $PSScriptRoot 'run-physical-basebackup-windows.ps1');arguments=@('-ConfigRoot',$ConfigRoot,'-PitrRoot',$root)}
    [ordered]@{name="$TaskPrefix Monitor";script=(Join-Path $PSScriptRoot 'run-pitr-monitor-windows.ps1');arguments=@('-ConfigRoot',$ConfigRoot,'-PitrRoot',$root)}
    [ordered]@{name=$LogicalTaskName;script=(Join-Path $PSScriptRoot 'run-policy-windows.ps1');arguments=@('-ConfigRoot',$ConfigRoot)}
)
foreach ($path in @($hiddenLauncher) + @($workers.script)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required launcher component is missing: $path" }
}
$plan = @($workers | ForEach-Object {
    [ordered]@{name=$_.name;execute=$wscript;arguments=(Hidden-Arguments $_.script $_.arguments);enable=[bool]$Enable}
})
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 5; return }

Set-RepairStatus 'RUNNING' 'Replacing visible PowerShell task actions with the invisible Windows Script Host launcher.'
try {
    foreach ($item in $plan) {
        $task = Get-ScheduledTask -TaskName $item.name -ErrorAction Stop
        $action = New-ScheduledTaskAction -Execute $item.execute -Argument $item.arguments
        Set-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Action $action | Out-Null
        if ($Enable) { Enable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null }
    }
    Set-RepairStatus 'PASS' "Repaired $($plan.Count) resilience task actions; enabled=$([bool]$Enable)."
    $plan | ConvertTo-Json -Depth 5
}
catch {
    Set-RepairStatus 'FAIL' $_.Exception.Message
    throw
}
