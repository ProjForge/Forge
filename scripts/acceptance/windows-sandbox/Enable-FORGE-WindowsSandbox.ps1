[CmdletBinding()]
param([string]$OutputPath)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell window.'
}
$result = Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart
$status = [ordered]@{
    feature = 'Containers-DisposableClientVM'
    state = [string]$result.State
    restartNeeded = [bool]$result.RestartNeeded
}
$json = $status | ConvertTo-Json
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutput) | Out-Null
    [IO.File]::WriteAllText($resolvedOutput, $json, [Text.UTF8Encoding]::new($false))
}
$json
