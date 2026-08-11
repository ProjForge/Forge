[CmdletBinding()]
param([string]$OutputRoot)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $projectRoot '..\forge-workbench-windows-0.1.1'
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$stage = Join-Path $OutputRoot 'FORGE-Workbench-0.1.1-Windows-x64'

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

Push-Location $projectRoot
try {
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed' }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $bundle = Join-Path $OutputRoot 'workbench-bundle.cjs'
    $esbuild = Join-Path $projectRoot 'node_modules\.bin\esbuild.cmd'
    & $esbuild 'dist/windows-launcher.js' '--bundle' '--platform=node' '--format=cjs' '--target=node22' '--packages=bundle' ('--outfile=' + $bundle)
    if ($LASTEXITCODE -ne 0) { throw 'Windows bundle failed' }
    $pkg = Join-Path $projectRoot 'node_modules\.bin\pkg.cmd'
    & $pkg $bundle '--targets' 'node22-win-x64' '--output' (Join-Path $stage 'FORGE-Workbench.exe') '--compress' 'Zstd' '--no-bytecode' '--public'
    if ($LASTEXITCODE -ne 0) { throw 'Windows executable packaging failed' }
} finally {
    Pop-Location
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-FORGE-Workbench.ps1'), (Join-Path $PSScriptRoot 'Uninstall-FORGE-Workbench.ps1'), (Join-Path $PSScriptRoot 'Launch-FORGE-Workbench.vbs'), (Join-Path $PSScriptRoot 'README-Windows.md') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'public') -Destination $stage -Recurse -Force
$checksums = Get-ChildItem -LiteralPath $stage -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    '{0}  {1}' -f (Get-Sha256 $_.FullName), $relative
}
$checksums | Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Encoding ascii
$zip = Join-Path $OutputRoot 'FORGE-Workbench-0.1.1-Windows-x64.zip'
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal -Force
(Get-Sha256 $zip) + '  ' + (Split-Path -Leaf $zip) | Set-Content -LiteralPath (Join-Path $OutputRoot 'FORGE-Workbench-0.1.1-Windows-x64-SHA256SUMS.txt') -Encoding ascii
Write-Output $zip
