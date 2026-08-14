[CmdletBinding()]
param(
    [string]$OutputRoot,
    [string]$ExpectedTag,
    [string]$SigningCertificateThumbprint,
    [string]$TimestampUrl,
    [switch]$RequireSigned
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$metadata = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$metadata.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-rc\.\d+)?$') { throw "Unsupported release version: $version" }
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repositoryRoot ('artifacts\v{0}-candidate' -f $version)
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if ($OutputRoot -eq $repositoryRoot) { throw 'OutputRoot cannot be the repository root.' }
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

$git = (Get-Command git.exe -ErrorAction Stop).Source
$commit = (& $git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Unable to identify the source commit.' }
$dirty = (& $git -C $repositoryRoot status --porcelain --untracked-files=all | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the source worktree.' }
if (-not [string]::IsNullOrWhiteSpace($dirty)) { throw 'Release assembly requires a clean source worktree.' }

if (-not [string]::IsNullOrWhiteSpace($ExpectedTag)) {
    if ($ExpectedTag -ne ('v' + $version)) { throw "Expected tag $ExpectedTag does not match package version $version." }
    & $git -C $repositoryRoot show-ref --verify --quiet ('refs/tags/' + $ExpectedTag)
    if ($LASTEXITCODE -ne 0) { throw "Release tag does not exist locally: $ExpectedTag" }
    $tagType = (& $git -C $repositoryRoot cat-file -t ('refs/tags/' + $ExpectedTag)).Trim()
    if ($LASTEXITCODE -ne 0 -or $tagType -ne 'tag') { throw "Release tag must be annotated: $ExpectedTag" }
    $tagCommit = (& $git -C $repositoryRoot rev-list -n 1 $ExpectedTag).Trim()
    if ($LASTEXITCODE -ne 0 -or $tagCommit -ne $commit) { throw 'Release tag does not resolve exactly to the checked-out commit.' }
}

$packagerArgs = @{ OutputRoot = $OutputRoot }
if (-not [string]::IsNullOrWhiteSpace($SigningCertificateThumbprint)) {
    $packagerArgs.SigningCertificateThumbprint = $SigningCertificateThumbprint
    $packagerArgs.TimestampUrl = $TimestampUrl
}
& (Join-Path $repositoryRoot 'packages\workbench\packaging\windows\Build-Windows-Package.ps1') @packagerArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Workbench packaging failed.' }

$sourceZipName = 'FORGE-{0}-source.zip' -f $version
$sourceZip = Join-Path $OutputRoot $sourceZipName
Remove-Item -LiteralPath $sourceZip -Force -ErrorAction SilentlyContinue
$archivePrefix = '--prefix=FORGE-{0}/' -f $version
$archiveOutput = '--output={0}' -f $sourceZip
& $git -C $repositoryRoot archive '--format=zip' $archivePrefix $archiveOutput 'HEAD'
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sourceZip -PathType Leaf)) { throw 'Source archive creation failed.' }

$workbenchZipName = 'FORGE-Workbench-{0}-Windows-x64.zip' -f $version
$workbenchZip = Join-Path $OutputRoot $workbenchZipName
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
@(
    '{0}  {1}' -f (Get-Sha256 $sourceZip), $sourceZipName
    '{0}  {1}' -f (Get-Sha256 $workbenchZip), $workbenchZipName
) | Set-Content -LiteralPath (Join-Path $OutputRoot 'SHA256SUMS.txt') -Encoding ascii

$verifyArgs = @{
    OutputRoot = $OutputRoot
    ExpectedVersion = $version
    ExpectedCommit = $commit
}
if ($RequireSigned -or -not [string]::IsNullOrWhiteSpace($SigningCertificateThumbprint)) { $verifyArgs.RequireSigned = $true }
& (Join-Path $PSScriptRoot 'Test-FORGE-WindowsRelease.ps1') @verifyArgs
