[CmdletBinding()]
param([string]$TemporaryRoot = [IO.Path]::GetTempPath())

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$fixtureRoot = Join-Path $TemporaryRoot ('forge-workbench-lifecycle-' + [Guid]::NewGuid().ToString('N'))
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
    New-TestDistribution $v1 '0.2.0-rc.4' 'payload-v1'
    New-TestDistribution $v2 '0.2.0-rc.5' 'payload-v2'
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
    if ((Get-Content -Raw -LiteralPath (Join-Path $installRoot 'RELEASE.json') | ConvertFrom-Json).version -ne '0.2.0-rc.5') { throw 'Installed release metadata was not updated.' }

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
    $checked = Join-Path $fixtureRoot 'checked'
    New-TestDistribution $checked '0.2.0-rc.6' 'placeholder'
    $fixtureSource = Join-Path $fixtureRoot 'ProbeFixture.cs'
    @"
using System;
using System.IO;
using System.Text;

internal static class ProbeFixture
{
    private static int Main(string[] args)
    {
        using (var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
        {
            string password = input.ReadToEnd();
            if (args.Length == 3 && args[0] == "--check-database" && args[1] == "existing")
                return password.Length == 0 && File.Exists(Path.Combine(args[2], "workbench.json")) ? 0 : 14;
            if (args.Length != 6 || args[0] != "--check-database" || args[1] != "entered" ||
                args[2] != "fixture host" || args[3] != "5432" || args[5] != "fixture user" ||
                password != "fixture-\u00e9-runtime")
                return 14;
            int category;
            return int.TryParse(args[4], out category) ? category : 0;
        }
    }
}
"@ | Set-Content -LiteralPath $fixtureSource -Encoding ascii
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo ('/out:' + (Join-Path $checked 'FORGE-Workbench.exe')) $fixtureSource
    if ($LASTEXITCODE -ne 0) { throw 'Probe fixture compilation failed.' }
    Set-Content -LiteralPath (Join-Path $checked 'FORGE-Setup.exe') -Value 'fixture' -Encoding ascii
    $manifest = Join-Path $checked 'SHA256SUMS.txt'
    Get-ChildItem -LiteralPath $checked -File -Recurse | Where-Object { $_.FullName -ne $manifest } | ForEach-Object {
        '{0}  {1}' -f (Get-Sha256 $_.FullName), $_.FullName.Substring($checked.Length + 1).Replace('\','/')
    } | Set-Content -LiteralPath $manifest -Encoding ascii

    $checkedInstall = Join-Path $fixtureRoot 'checked install'
    $checkedConfig = Join-Path $fixtureRoot 'checked config'
    $probePassword = ConvertTo-SecureString ("fixture-" + [char]0x00e9 + "-runtime") -AsPlainText -Force
    $probeArgs = @{
        InstallRoot = $checkedInstall; ConfigRoot = $checkedConfig; DatabasePassword = $probePassword
        DatabaseHost = 'fixture host'; DatabaseUser = 'fixture user'; NoShortcuts = $true; NoLaunch = $true
    }
    try {
        $categories = @{ '10' = 'rejected the credentials'; '11' = 'schema migrations'; '12' = 'runtime permissions'; '13' = 'unavailable' }
        foreach ($code in $categories.Keys) {
            $diagnosed = $false
            try { & (Join-Path $checked 'Install-FORGE-Workbench.ps1') @probeArgs -DatabaseName $code | Out-Null }
            catch { $diagnosed = $_.Exception.Message.Contains($categories[$code]) }
            if (-not $diagnosed -or (Test-Path -LiteralPath $checkedInstall) -or (Test-Path -LiteralPath $checkedConfig)) {
                throw "Probe category $code did not prevent all installation writes."
            }
        }
        & (Join-Path $checked 'Install-FORGE-Workbench.ps1') @probeArgs -CheckOnly | Out-Null
        if ((Test-Path -LiteralPath $checkedInstall) -or (Test-Path -LiteralPath $checkedConfig)) { throw 'CheckOnly wrote installation state.' }
        & (Join-Path $checked 'Install-FORGE-Workbench.ps1') @probeArgs | Out-Null
        $checkedConfigFile = Join-Path $checkedConfig 'workbench.json'
        $checkedCredential = Join-Path $checkedConfig 'workbench.dpapi'
        $savedConfigHash = Get-Sha256 $checkedConfigFile
        $savedCredentialHash = Get-Sha256 $checkedCredential
        & (Join-Path $checked 'Install-FORGE-Workbench.ps1') -InstallRoot $checkedInstall -ConfigRoot $checkedConfig -NoShortcuts -NoLaunch | Out-Null
        if ((Get-Sha256 $checkedConfigFile) -ne $savedConfigHash -or (Get-Sha256 $checkedCredential) -ne $savedCredentialHash) {
            throw 'Checked update did not preserve both files byte for byte.'
        }
        $sentinel = Join-Path $checkedInstall 'previous-app.txt'
        Set-Content -LiteralPath $sentinel -Value 'previous app'
        $lockedConfig = [IO.File]::Open($checkedConfigFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $rollbackTriggered = $false
        try {
            try { & (Join-Path $checked 'Install-FORGE-Workbench.ps1') @probeArgs -Reconfigure -WorkbenchPort 7444 | Out-Null }
            catch { $rollbackTriggered = $true }
        } finally { $lockedConfig.Dispose() }
        if (-not $rollbackTriggered -or -not (Test-Path -LiteralPath $sentinel) -or
            (Get-Sha256 $checkedConfigFile) -ne $savedConfigHash -or (Get-Sha256 $checkedCredential) -ne $savedCredentialHash) {
            throw 'A failure during configuration publication did not restore application and credential.'
        }
        & (Join-Path $checked 'Install-FORGE-Workbench.ps1') @probeArgs -Reconfigure -ConnectionOnly | Out-Null
        $newConfig = Get-Content -Raw -LiteralPath $checkedConfigFile | ConvertFrom-Json
        if (-not (Test-Path -LiteralPath $sentinel) -or $newConfig.database.credentialFile -eq 'workbench.dpapi' -or
            -not (Test-Path -LiteralPath (Join-Path $checkedConfig $newConfig.database.credentialFile)) -or
            (Get-Sha256 $checkedCredential) -ne $savedCredentialHash) {
            throw 'Changing only the connection did not preserve the application and publish a new credential.'
        }
        & (Join-Path $checked 'Install-FORGE-Workbench.ps1') @probeArgs -Reconfigure -WorkbenchPort 7444 | Out-Null
        if ((Get-Content -Raw -LiteralPath (Join-Path $checkedInstall 'workbench.url')) -ne 'http://127.0.0.1:7444') {
            throw 'Reconfigure did not publish the new Workbench port.'
        }
    } finally { $probePassword.Dispose() }
    Write-Output 'PASS: Package probe uses private UTF-8 stdin, classifies errors and checks saved settings without replacing them.'

    Write-Output 'PASS: Workbench install, update, rollback guards and data-preserving uninstall are safe.'
} finally { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
