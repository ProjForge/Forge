[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidateArchive,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [string]$BaselineUrl = 'https://github.com/ProjForge/Forge/releases/download/v0.2.0-rc.2/FORGE-Workbench-0.2.0-rc.2-Windows-x64.zip',
    [ValidatePattern('^[0-9A-Fa-f]{64}$')][string]$BaselineSha256 = 'F8517E7A86DE6F8892DD23401ADBC594837862E6EDB5732372622A7462B4D0BB',
    [string]$WorkingRoot = ([IO.Path]::GetTempPath())
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'The Windows release upgrade test requires Windows.' }
$CandidateArchive = [IO.Path]::GetFullPath($CandidateArchive)
if (-not (Test-Path -LiteralPath $CandidateArchive -PathType Leaf) -or [IO.Path]::GetExtension($CandidateArchive) -ne '.zip') { throw 'CandidateArchive must be an existing ZIP.' }
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+(?:-rc\.\d+)?$') { throw 'ExpectedVersion is invalid.' }

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Find-DistributionRoot([string]$Root) {
    $installer = Get-ChildItem -LiteralPath $Root -Filter 'Install-FORGE-Workbench.ps1' -File -Recurse | Select-Object -First 1
    if ($null -eq $installer) { throw 'The archive does not contain a Workbench installer.' }
    return $installer.Directory.FullName
}

$WorkingRoot = [IO.Path]::GetFullPath($WorkingRoot)
New-Item -ItemType Directory -Path $WorkingRoot -Force | Out-Null
$testRoot = Join-Path $WorkingRoot ('forge-release-upgrade-' + [Guid]::NewGuid().ToString('N'))
$baselineZip = Join-Path $testRoot 'baseline.zip'
$baselineRoot = Join-Path $testRoot 'baseline'
$candidateRoot = Join-Path $testRoot 'candidate'
$installRoot = Join-Path $testRoot 'installed'
$configRoot = Join-Path $testRoot 'config'
$diagnosticsZip = Join-Path $testRoot 'diagnostics.zip'
$diagnosticsRoot = Join-Path $testRoot 'diagnostics'
$fixturePasswordText = 'forge-isolated-release-upgrade-fixture'
$fixturePassword = $null
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $BaselineUrl -OutFile $baselineZip
    $baselineHash = Get-Sha256 $baselineZip
    if ($baselineHash -ne $BaselineSha256.ToUpperInvariant()) { throw 'The public rc.2 baseline digest does not match the pinned release asset.' }
    Expand-Archive -LiteralPath $baselineZip -DestinationPath $baselineRoot
    Expand-Archive -LiteralPath $CandidateArchive -DestinationPath $candidateRoot
    $baselineDistribution = Find-DistributionRoot $baselineRoot
    $candidateDistribution = Find-DistributionRoot $candidateRoot

    $fixturePassword = ConvertTo-SecureString $fixturePasswordText -AsPlainText -Force
    & (Join-Path $baselineDistribution 'Install-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -DatabasePassword $fixturePassword -NoShortcuts -NoLaunch | Out-Null
    $configPath = Join-Path $configRoot 'workbench.json'
    $configuration = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $credentialPath = Join-Path $configRoot ([string]$configuration.database.credentialFile)
    $configHashBefore = Get-Sha256 $configPath
    $credentialHashBefore = Get-Sha256 $credentialPath

    & (Join-Path $candidateDistribution 'Install-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -NoShortcuts -NoLaunch | Out-Null
    if ((Get-Sha256 $configPath) -ne $configHashBefore -or (Get-Sha256 $credentialPath) -ne $credentialHashBefore) { throw 'The candidate update changed shared configuration or DPAPI material.' }
    $installedRelease = Get-Content -Raw -LiteralPath (Join-Path $installRoot 'RELEASE.json') | ConvertFrom-Json
    if ([string]$installedRelease.version -ne $ExpectedVersion) { throw 'The installed release version does not match the candidate.' }

    & (Join-Path $installRoot 'Export-FORGE-Diagnostics.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -OutputPath $diagnosticsZip | Out-Null
    Expand-Archive -LiteralPath $diagnosticsZip -DestinationPath $diagnosticsRoot
    $diagnosticsText = Get-ChildItem -LiteralPath $diagnosticsRoot -File -Recurse | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName } | Out-String
    if ($diagnosticsText.Contains($fixturePasswordText)) { throw 'The diagnostics bundle exposed the release-upgrade fixture secret.' }
    $diagnostics = Get-Content -Raw -LiteralPath (Join-Path $diagnosticsRoot 'diagnostics.json') | ConvertFrom-Json
    if ([string]$diagnostics.release.version -ne $ExpectedVersion -or -not $diagnostics.configuration.credentialPresent) { throw 'The diagnostics bundle did not report the updated installation safely.' }

    & (Join-Path $installRoot 'Uninstall-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot | Out-Null
    if ((Test-Path -LiteralPath $installRoot) -or -not (Test-Path -LiteralPath $configPath -PathType Leaf) -or -not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) { throw 'The post-update uninstaller did not preserve user configuration.' }
    [ordered]@{
        passed = $true
        baselineVersion = '0.2.0-rc.2'
        candidateVersion = $ExpectedVersion
        baselineSha256 = $baselineHash
        configurationPreserved = $true
        credentialPreserved = $true
        diagnosticsRedacted = $true
        uninstallPreservedConfiguration = $true
    } | ConvertTo-Json -Compress | Write-Output
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $workingPrefix = $WorkingRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($resolvedTestRoot.StartsWith($workingPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTestRoot) -like 'forge-release-upgrade-*') {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $fixturePassword = $null
    $fixturePasswordText = $null
}
