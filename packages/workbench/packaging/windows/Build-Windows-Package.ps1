[CmdletBinding()]
param(
    [string]$OutputRoot,
    [string]$SigningCertificateThumbprint,
    [string]$TimestampUrl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..\..'))
$packageMetadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$packageMetadata.version
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $projectRoot ("..\forge-workbench-windows-{0}" -f $version)
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$stageName = 'FORGE-Workbench-{0}-Windows-x64' -f $version
$stage = Join-Path $OutputRoot $stageName
if (-not $stage.StartsWith($OutputRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Invalid package staging path.'
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-SignTool {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    $kitsRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    if (Test-Path -LiteralPath $kitsRoot) {
        $candidate = Get-ChildItem -LiteralPath $kitsRoot -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($null -ne $candidate) { return $candidate.FullName }
    }
    throw 'signtool.exe was not found. Install the Windows SDK signing tools.'
}

Push-Location $repositoryRoot
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Monorepo build failed' }
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $bundle = Join-Path $OutputRoot 'workbench-bundle.cjs'
    $esbuild = Join-Path $repositoryRoot 'node_modules\.bin\esbuild.cmd'
    $entryPoint = Join-Path $projectRoot 'dist\windows-launcher.js'
    & $esbuild $entryPoint '--bundle' '--platform=node' '--format=cjs' '--target=node22' '--packages=bundle' ('--outfile=' + $bundle)
    if ($LASTEXITCODE -ne 0) { throw 'Windows bundle failed' }
    $pkg = Join-Path $repositoryRoot 'node_modules\.bin\pkg.cmd'
    & $pkg $bundle '--targets' 'node22-win-x64' '--output' (Join-Path $stage 'FORGE-Workbench.exe') '--compress' 'Zstd' '--no-bytecode' '--public'
    if ($LASTEXITCODE -ne 0) { throw 'Windows executable packaging failed' }
} finally {
    Pop-Location
}

$executable = Join-Path $stage 'FORGE-Workbench.exe'
$signed = -not [string]::IsNullOrWhiteSpace($SigningCertificateThumbprint)
if ($signed) {
    if ([string]::IsNullOrWhiteSpace($TimestampUrl)) {
        throw 'TimestampUrl is required when signing a release.'
    }
    $signTool = Get-SignTool
    & $signTool sign /sha1 $SigningCertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $executable
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed' }
    & $signTool verify /pa /all $executable
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode verification failed' }
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-FORGE-Workbench.ps1'), (Join-Path $PSScriptRoot 'Uninstall-FORGE-Workbench.ps1'), (Join-Path $PSScriptRoot 'Launch-FORGE-Workbench.vbs'), (Join-Path $PSScriptRoot 'README-Windows.md') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE'), (Join-Path $repositoryRoot 'NOTICE') -Destination $stage -Force
& node (Join-Path $repositoryRoot 'scripts\generate-third-party-notices.mjs') '--output' (Join-Path $stage 'THIRD-PARTY-NOTICES.txt')
if ($LASTEXITCODE -ne 0) { throw 'Third-party notice generation failed' }
Copy-Item -LiteralPath (Join-Path $projectRoot 'public') -Destination $stage -Recurse -Force
$commit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
$dirty = -not [string]::IsNullOrWhiteSpace((& git -C $repositoryRoot status --porcelain | Out-String))
[ordered]@{
    product = 'FORGE Workbench'
    version = $version
    platform = 'windows-x64'
    sourceCommit = $commit
    sourceDirty = $dirty
    authenticodeSigned = $signed
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'RELEASE.json') -Encoding utf8
$checksums = Get-ChildItem -LiteralPath $stage -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    '{0}  {1}' -f (Get-Sha256 $_.FullName), $relative
}
$checksums | Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Encoding ascii
$zip = Join-Path $OutputRoot ($stageName + '.zip')
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal -Force
(Get-Sha256 $zip) + '  ' + (Split-Path -Leaf $zip) | Set-Content -LiteralPath (Join-Path $OutputRoot ($stageName + '-SHA256SUMS.txt')) -Encoding ascii
Write-Output $zip
