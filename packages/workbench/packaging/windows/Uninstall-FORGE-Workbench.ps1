[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\FORGE Workbench'),
    [string]$ConfigRoot = (Join-Path $env:APPDATA 'FORGE'),
    [switch]$PurgeUserData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
$localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
if ($resolvedRoot -eq $localAppData -or $resolvedRoot.Length -le $localAppData.Length) {
    throw 'Refusing to remove an unsafe installation path.'
}

Get-Process -Name 'FORGE-Workbench' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force

$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'FORGE Workbench.lnk'
Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue

if ($PurgeUserData) {
    $resolvedConfig = [IO.Path]::GetFullPath($ConfigRoot)
    $appData = [IO.Path]::GetFullPath($env:APPDATA)
    if ($resolvedConfig -eq $appData -or $resolvedConfig.Length -le $appData.Length) {
        throw 'Refusing to remove an unsafe configuration path.'
    }
    Remove-Item -LiteralPath $resolvedConfig -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'FORGE Workbench was uninstalled.'
if (-not $PurgeUserData) { Write-Output "User configuration was preserved in $ConfigRoot" }
