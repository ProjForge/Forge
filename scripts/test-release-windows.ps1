[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$builder = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Build-FORGE-WindowsRelease.ps1') -Raw
$verifier = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Test-FORGE-WindowsRelease.ps1') -Raw
$packager = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\packages\workbench\packaging\windows\Build-Windows-Package.ps1') -Raw
$installer = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\packages\workbench\packaging\windows\Install-FORGE-Workbench.ps1') -Raw
$upgradeTest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'test-windows-release-upgrade.ps1') -Raw

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
    $packager -match '(?m)^\s*& npm\.cmd (?:ci|run build)\s*$' -or
    $packager -notmatch 'Export-FORGE-Diagnostics\.ps1') {
    throw 'Workbench packaging still depends directly on the environment npm.cmd wrapper.'
}
foreach ($required in @('Test-Distribution','Refusing to downgrade','requires -Reconfigure','DPAPI credential were preserved','forge-workbench-backup')) {
    if ($installer -notmatch $required) { throw "Workbench installer lost lifecycle invariant: $required" }
}
foreach ($required in @('A3BDDEDC78BE78B675BD2A450584BEA9AB675CB7F892B54C96A70BA5E3F36C25','configuration or DPAPI material','Export-FORGE-Diagnostics','Uninstall-FORGE-Workbench')) {
    if ($upgradeTest -notmatch $required) { throw "Published-baseline upgrade test lost invariant: $required" }
}
Write-Output 'PASS: Windows release assembly remains clean, tag-bound and fail-closed.'
