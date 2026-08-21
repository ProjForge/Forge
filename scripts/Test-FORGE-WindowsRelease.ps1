[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,
    [switch]$RequireSigned
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$stageName = 'FORGE-Workbench-{0}-Windows-x64' -f $ExpectedVersion
$stage = Join-Path $OutputRoot $stageName
$workbenchZip = Join-Path $OutputRoot ($stageName + '.zip')
$workbenchManifest = Join-Path $OutputRoot ($stageName + '-SHA256SUMS.txt')
$sourceZipName = 'FORGE-{0}-source.zip' -f $ExpectedVersion
$sourceZip = Join-Path $OutputRoot $sourceZipName
$releaseManifest = Join-Path $OutputRoot 'SHA256SUMS.txt'
$evidencePath = Join-Path $OutputRoot 'release-verification.json'

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Read-ChecksumManifest([string]$Path) {
    $entries = @()
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([0-9A-Fa-f]{64})  (.+)$') {
            throw "Invalid checksum manifest line in ${Path}: $line"
        }
        $entries += [pscustomobject]@{ Hash = $Matches[1].ToUpperInvariant(); Name = $Matches[2] }
    }
    if ($entries.Count -eq 0) { throw "Checksum manifest is empty: $Path" }
    return $entries
}

foreach ($required in @($stage, $workbenchZip, $workbenchManifest, $sourceZip, $releaseManifest)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required release path is missing: $required" }
}
foreach ($requiredName in @('Install-FORGE-Workbench.ps1', 'Uninstall-FORGE-Workbench.ps1', 'Export-FORGE-Diagnostics.ps1', 'RELEASE.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $requiredName) -PathType Leaf)) { throw "Required Windows lifecycle file is missing: $requiredName" }
}

$release = Get-Content -LiteralPath (Join-Path $stage 'RELEASE.json') -Raw | ConvertFrom-Json
if ($release.product -ne 'FORGE Workbench' -or
    $release.version -ne $ExpectedVersion -or
    $release.platform -ne 'windows-x64' -or
    $release.sourceCommit -ne $ExpectedCommit -or
    $release.sourceDirty -ne $false -or
    $release.sourceState -notin @('repository', 'ci-environment')) {
    throw 'RELEASE.json does not match the clean source being verified.'
}

$internalEntries = @(Read-ChecksumManifest (Join-Path $stage 'SHA256SUMS.txt'))
$stagePrefix = $stage + [IO.Path]::DirectorySeparatorChar
foreach ($entry in $internalEntries) {
    if ([IO.Path]::IsPathRooted($entry.Name) -or $entry.Name -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "Unsafe internal checksum path: $($entry.Name)"
    }
    $target = [IO.Path]::GetFullPath((Join-Path $stage $entry.Name.Replace('/', [IO.Path]::DirectorySeparatorChar)))
    if (-not $target.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw "Internal checksum target is missing or outside the package: $($entry.Name)"
    }
    if ((Get-Sha256 $target) -ne $entry.Hash) { throw "Internal checksum mismatch: $($entry.Name)" }
}
$packagedFiles = @(Get-ChildItem -LiteralPath $stage -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS.txt' })
if ($packagedFiles.Count -ne $internalEntries.Count) {
    throw 'The internal checksum manifest does not cover every packaged file exactly once.'
}

$standaloneEntries = @(Read-ChecksumManifest $workbenchManifest)
if ($standaloneEntries.Count -ne 1 -or $standaloneEntries[0].Name -ne (Split-Path -Leaf $workbenchZip) -or
    $standaloneEntries[0].Hash -ne (Get-Sha256 $workbenchZip)) {
    throw 'The standalone Workbench checksum manifest is invalid.'
}

$outerEntries = @(Read-ChecksumManifest $releaseManifest)
$expectedOuterNames = @($sourceZipName, (Split-Path -Leaf $workbenchZip))
if ($outerEntries.Count -ne 2 -or
    (@($outerEntries.Name | Sort-Object) -join "`n") -ne (@($expectedOuterNames | Sort-Object) -join "`n")) {
    throw 'The release checksum manifest must cover exactly the source and Workbench archives.'
}
foreach ($entry in $outerEntries) {
    $target = Join-Path $OutputRoot $entry.Name
    if ((Get-Sha256 $target) -ne $entry.Hash) { throw "Release checksum mismatch: $($entry.Name)" }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceArchive = [IO.Compression.ZipFile]::OpenRead($sourceZip)
try {
    $prefix = 'FORGE-{0}/' -f $ExpectedVersion
    if ($sourceArchive.Entries.Count -eq 0 -or
        @($sourceArchive.Entries | Where-Object { -not $_.FullName.StartsWith($prefix, [StringComparison]::Ordinal) }).Count -ne 0 -or
        $null -eq ($sourceArchive.Entries | Where-Object { $_.FullName -eq ($prefix + 'package.json') } | Select-Object -First 1)) {
        throw 'The source archive is empty, has an unsafe root, or is missing package.json.'
    }
} finally { $sourceArchive.Dispose() }

$executable = Join-Path $stage 'FORGE-Workbench.exe'
$versionInfo = (Get-Item -LiteralPath $executable).VersionInfo
$versionParts = $ExpectedVersion -match '^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$'
if (-not $versionParts) { throw "Unsupported release version: $ExpectedVersion" }
$revision = if ([string]::IsNullOrWhiteSpace($Matches[4])) { 0 } else { [int]$Matches[4] }
$expectedWindowsVersion = '{0}.{1}.{2}.{3}' -f $Matches[1], $Matches[2], $Matches[3], $revision
if ($versionInfo.ProductName -ne 'FORGE Workbench' -or $versionInfo.CompanyName -ne 'ProjForge' -or
    $versionInfo.ProductVersion -ne $expectedWindowsVersion -or $versionInfo.OriginalFilename -ne 'FORGE-Workbench.exe') {
    throw 'The executable identity does not match FORGE release metadata.'
}

$signature = Get-AuthenticodeSignature -LiteralPath $executable
$isSigned = $signature.Status -eq [Management.Automation.SignatureStatus]::Valid
if ($RequireSigned -and (-not $isSigned -or $null -eq $signature.TimeStamperCertificate)) {
    throw "A valid timestamped Authenticode signature is required; status is $($signature.Status)."
}
if (-not $RequireSigned -and $signature.Status -notin @(
        [Management.Automation.SignatureStatus]::NotSigned,
        [Management.Automation.SignatureStatus]::Valid)) {
    throw "Unexpected Authenticode status: $($signature.Status)."
}
if ([bool]$release.authenticodeSigned -ne $isSigned) {
    throw 'RELEASE.json signing provenance does not match the executable.'
}

$evidence = [ordered]@{
    verified = $true
    product = 'FORGE Workbench'
    version = $ExpectedVersion
    sourceCommit = $ExpectedCommit
    sourceDirty = $false
    authenticodeStatus = [string]$signature.Status
    timestamped = $null -ne $signature.TimeStamperCertificate
    sourceSha256 = Get-Sha256 $sourceZip
    workbenchSha256 = Get-Sha256 $workbenchZip
    internalFilesVerified = $internalEntries.Count
}
$evidence | ConvertTo-Json | Set-Content -LiteralPath $evidencePath -Encoding utf8
$evidence | ConvertTo-Json -Compress | Write-Output
