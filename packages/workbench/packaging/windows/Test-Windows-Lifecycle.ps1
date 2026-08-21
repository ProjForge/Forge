[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('forge-workbench-lifecycle-' + [Guid]::NewGuid().ToString('N'))
$packagingRoot = $PSScriptRoot

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function New-TestDistribution([string]$Root, [string]$Version, [string]$Payload) {
    New-Item -ItemType Directory -Path (Join-Path $Root 'public') -Force | Out-Null
    foreach ($name in @('Install-FORGE-Workbench.ps1','Uninstall-FORGE-Workbench.ps1','Export-FORGE-Diagnostics.ps1','Launch-FORGE-Workbench.vbs')) {
        Copy-Item -LiteralPath (Join-Path $packagingRoot $name) -Destination $Root
    }
    [IO.File]::WriteAllText((Join-Path $Root 'FORGE-Workbench.exe'), $Payload, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $Root 'public\index.html'), '<!doctype html>', [Text.UTF8Encoding]::new($false))
    [ordered]@{ product='FORGE Workbench'; version=$Version; platform='windows-x64'; sourceCommit=('a' * 40); sourceDirty=$false; sourceState='repository'; authenticodeSigned=$false } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'RELEASE.json') -Encoding utf8
    $manifest = Get-ChildItem -LiteralPath $Root -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length + 1).Replace('\','/')
        '{0}  {1}' -f (Get-Sha256 $_.FullName), $relative
    }
    $manifest | Set-Content -LiteralPath (Join-Path $Root 'SHA256SUMS.txt') -Encoding ascii
}

try {
    $v1 = Join-Path $fixtureRoot 'v1'
    $v2 = Join-Path $fixtureRoot 'v2'
    $installRoot = Join-Path $fixtureRoot 'installed'
    $configRoot = Join-Path $fixtureRoot 'config'
    New-TestDistribution $v1 '0.2.0-rc.3' 'payload-v1'
    New-TestDistribution $v2 '0.2.0-rc.4' 'payload-v2'
    $password = ConvertTo-SecureString 'fixture-runtime-password' -AsPlainText -Force

    & (Join-Path $v1 'Install-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -DatabasePassword $password -NoShortcuts -NoLaunch | Out-Null
    if ((Get-Content -Raw -LiteralPath (Join-Path $installRoot 'FORGE-Workbench.exe')) -ne 'payload-v1') { throw 'Fresh installation did not publish the expected application.' }
    $configPath = Join-Path $configRoot 'workbench.json'
    $credentialPath = Join-Path $configRoot 'workbench.dpapi'
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $config | Add-Member -NotePropertyName embedding -NotePropertyValue ([pscustomobject]@{ model='fixture-model' })
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $configurationBefore = Get-FileHash -LiteralPath $configPath -Algorithm SHA256
    $credentialBefore = Get-FileHash -LiteralPath $credentialPath -Algorithm SHA256

    & (Join-Path $v2 'Install-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -NoShortcuts -NoLaunch | Out-Null
    if ((Get-Content -Raw -LiteralPath (Join-Path $installRoot 'FORGE-Workbench.exe')) -ne 'payload-v2') { throw 'Update did not atomically publish the new application.' }
    if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash -ne $configurationBefore.Hash -or
        (Get-FileHash -LiteralPath $credentialPath -Algorithm SHA256).Hash -ne $credentialBefore.Hash) {
        throw 'Normal update changed shared configuration or DPAPI material.'
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $installRoot 'RELEASE.json') | ConvertFrom-Json).version -ne '0.2.0-rc.4') { throw 'Installed release metadata was not updated.' }

    $changeRejected = $false
    try { & (Join-Path $v2 'Install-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -WorkbenchPort 7444 -NoShortcuts -NoLaunch | Out-Null }
    catch { $changeRejected = $_.Exception.Message -match 'requires -Reconfigure' }
    if (-not $changeRejected) { throw 'Update silently changed connection settings without -Reconfigure.' }

    $downgradeRejected = $false
    try { & (Join-Path $v1 'Install-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -NoShortcuts -NoLaunch | Out-Null }
    catch { $downgradeRejected = $_.Exception.Message -match 'Refusing to downgrade' }
    if (-not $downgradeRejected -or (Get-Content -Raw -LiteralPath (Join-Path $installRoot 'FORGE-Workbench.exe')) -ne 'payload-v2') { throw 'Downgrade guard did not preserve the installed application.' }

    $lockedFailure = $false
    $lockedStream = [IO.File]::Open((Join-Path $installRoot 'FORGE-Workbench.exe'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        try { & (Join-Path $v2 'Install-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -NoShortcuts -NoLaunch | Out-Null }
        catch { $lockedFailure = $true }
    } finally { $lockedStream.Dispose() }
    if (-not $lockedFailure -or -not (Test-Path -LiteralPath (Join-Path $installRoot 'FORGE-Workbench.exe'))) { throw 'A pre-publication rename failure did not preserve the previous application.' }

    Add-Content -LiteralPath (Join-Path $v2 'FORGE-Workbench.exe') -Value 'tampered'
    $tamperRejected = $false
    try { & (Join-Path $v2 'Install-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -NoShortcuts -NoLaunch | Out-Null }
    catch { $tamperRejected = $_.Exception.Message -match 'checksum mismatch' }
    if (-not $tamperRejected -or (Get-Content -Raw -LiteralPath (Join-Path $installRoot 'FORGE-Workbench.exe')) -ne 'payload-v2') { throw 'Package tamper guard did not preserve the installed application.' }
    & (Join-Path $installRoot 'Uninstall-FORGE-Workbench.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot | Out-Null
    if (Test-Path -LiteralPath $installRoot) { throw 'Uninstaller did not remove the application.' }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or -not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) { throw 'Uninstaller removed preserved user configuration.' }
    Write-Output 'PASS: Workbench install, update, rollback guards and data-preserving uninstall are safe.'
} finally { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
