[CmdletBinding()]
param(
    [string]$HostName = '127.0.0.1',
    [int]$Port = 5432,
    [string]$Database = 'forge',
    [string]$BackupRole = 'forge_backup_reader',
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$ReplicaDirectory,
    [ValidateRange(1, 168)][int]$IntervalHours = 6,
    [ValidateRange(1, 3650)][int]$KeepLast = 14,
    [ValidateRange(1, 87600)][int]$MaxAgeHours = 720,
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$TaskName = 'FORGE Verified Recovery Backup',
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$installStatusPath = Join-Path $ConfigRoot 'resilience-install-status.json'
function Set-InstallStatus([string]$Status, [string]$Detail) {
    New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
    [ordered]@{ status = $Status; detail = $Detail; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $installStatusPath -Encoding utf8
}
trap {
    Set-InstallStatus 'FAIL' $_.Exception.Message
    Write-Error $_
    exit 1
}
Set-InstallStatus 'RUNNING' 'Configuring verified recovery schedule.'
if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Output "Removed scheduled task: $TaskName"
    exit 0
}

$packageRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $packageRoot 'dist\cli.js'
$runnerPath = Join-Path $PSScriptRoot 'run-policy-windows.ps1'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $cliPath)) { throw 'Build forge-resilience before installing the schedule.' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory) -or -not [IO.Path]::IsPathRooted($ReplicaDirectory)) {
    throw 'OutputDirectory and ReplicaDirectory must be absolute paths.'
}

New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
$policyPath = Join-Path $ConfigRoot 'resilience-policy.json'
$statusPath = Join-Path $ConfigRoot 'resilience-status.json'
$lockPath = Join-Path $ConfigRoot 'resilience.lock'
$runtimePath = Join-Path $ConfigRoot 'resilience-runtime.json'
$databaseSecretPath = Join-Path $ConfigRoot 'resilience-database.dpapi'
$passphraseSecretPath = Join-Path $ConfigRoot 'resilience-passphrase.dpapi'

$databasePassword = Read-Host "Password for PostgreSQL backup role '$BackupRole'" -AsSecureString
$backupPassphrase = Read-Host 'Recovery package passphrase (at least 20 characters)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($backupPassphrase)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([Text.Encoding]::UTF8.GetByteCount($plain) -lt 20) { throw 'Recovery passphrase must be at least 20 bytes.' }
}
finally {
    $plain = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
function Write-DpapiSecret([Security.SecureString]$Secret, [string]$Path) {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $secretPointer = [IntPtr]::Zero
    $plainBytes = $null
    $protectedBytes = $null
    try {
        $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
        $plainBytes = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer))
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($plainBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Convert]::ToBase64String($protectedBytes) | Set-Content -LiteralPath $Path -Encoding ascii
    }
    finally {
        if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
        if ($plainBytes) { [Array]::Clear($plainBytes,0,$plainBytes.Length) }
        if ($protectedBytes) { [Array]::Clear($protectedBytes,0,$protectedBytes.Length) }
    }
}
Write-DpapiSecret $databasePassword $databaseSecretPath
Write-DpapiSecret $backupPassphrase $passphraseSecretPath

[ordered]@{
    version = 1
    outputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    replicas = @([ordered]@{ name = 'filesystem-primary'; path = [IO.Path]::GetFullPath($ReplicaDirectory) })
    retention = [ordered]@{ keepLast = $KeepLast; maxAgeHours = $MaxAgeHours }
    labelPrefix = 'scheduled'
    lockPath = $lockPath
    statusPath = $statusPath
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $policyPath -Encoding utf8

[ordered]@{
    nodePath = $nodePath
    cliPath = $cliPath
    policyPath = $policyPath
    postgresBin = [IO.Path]::GetFullPath($PostgresBin)
    database = [ordered]@{ host = $HostName; port = $Port; name = $Database; user = $BackupRole }
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $runtimePath -Encoding utf8

$wscript = "$env:SystemRoot\System32\wscript.exe"
$hiddenLauncher = Join-Path $PSScriptRoot 'run-powershell-hidden.vbs'
if (-not (Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) { throw 'Hidden PowerShell launcher is missing.' }
$arguments = "`"$hiddenLauncher`" `"$runnerPath`" `"-ConfigRoot`" `"$ConfigRoot`""
$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logonTrigger, $periodicTrigger) -Settings $settings -Principal $principal -Description 'Creates, verifies, replicates and retains encrypted FORGE recovery packages.' -Force | Out-Null

Set-InstallStatus 'PASS' "Registered scheduled task: $TaskName"
Write-Output "Registered scheduled task: $TaskName"
Write-Output "Policy: $policyPath"
Write-Output "Status: $statusPath"
