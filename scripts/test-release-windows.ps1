[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$builder = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Build-FORGE-WindowsRelease.ps1') -Raw
$verifier = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Test-FORGE-WindowsRelease.ps1') -Raw
$packager = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\packages\workbench\packaging\windows\Build-Windows-Package.ps1') -Raw

foreach ($required in @(
    'status --porcelain --untracked-files=all',
    'Release assembly requires a clean source worktree',
    'Release tag must be annotated',
    'Release tag does not resolve exactly to the checked-out commit',
    'git.*archive',
    '\$archivePrefix\s*=\s*''--prefix=FORGE-',
    '\$archiveOutput\s*=\s*''--output=',
    'SHA256SUMS\.txt',
    'Test-FORGE-WindowsRelease\.ps1',
    '\$packagerArgs\s*=\s*@\{',
    '\$verifyArgs\s*=\s*@\{'
)) {
    if ($builder -notmatch $required) { throw "Release builder lost invariant: $required" }
}
foreach ($required in @(
    'sourceDirty -ne \$false',
    'Internal checksum mismatch',
    'release checksum manifest must cover exactly',
    'Get-AuthenticodeSignature',
    'TimeStamperCertificate',
    'executable identity does not match FORGE'
)) {
    if ($verifier -notmatch $required) { throw "Release verifier lost invariant: $required" }
}
if ($packager -notmatch 'node_modules\\npm\\bin\\npm-cli\.js' -or
    $packager -match '(?m)^\s*& npm\.cmd (?:ci|run build)\s*$') {
    throw 'Workbench packaging still depends directly on the environment npm.cmd wrapper.'
}
Write-Output 'PASS: Windows release assembly remains clean, tag-bound and fail-closed.'
