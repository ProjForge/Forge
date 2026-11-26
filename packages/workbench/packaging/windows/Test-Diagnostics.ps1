[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSModuleAutoLoadingPreference = 'None'
Import-Module Microsoft.PowerShell.Management, Microsoft.PowerShell.Security, Microsoft.PowerShell.Utility, CimCmdlets
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('forge-diagnostics-test-' + [Guid]::NewGuid().ToString('N'))
$secret = 'FORGE_TEST_SECRET_MUST_NOT_LEAK'
try {
    $installRoot = Join-Path $fixtureRoot 'installed'
    $configRoot = Join-Path $fixtureRoot 'config'
    $archive = Join-Path $fixtureRoot 'diagnostics.zip'
    New-Item -ItemType Directory -Path $installRoot, $configRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $installRoot 'FORGE-Workbench.exe'), 'fixture', [Text.UTF8Encoding]::new($false))
    [ordered]@{ product='FORGE Workbench'; version='0.2.0-rc.5'; sourceCommit=$secret } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installRoot 'RELEASE.json') -Encoding utf8
    [ordered]@{
        database=[ordered]@{host=$secret;port=5432;name=$secret;user=$secret;credentialFile='workbench.dpapi'}
        workbench=[ordered]@{port=7334}
        embedding=[ordered]@{model=$secret;rerankerModel='configured'}
        privateNote=$secret
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $configRoot 'workbench.json') -Encoding utf8
    $secret | Set-Content -LiteralPath (Join-Path $configRoot 'workbench.dpapi') -Encoding ascii
    @{status='PASS';updatedAt='2026-08-14T00:00:00Z';message=$secret} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configRoot 'embedding-worker-status.json') -Encoding utf8
    [ordered]@{status='PASS';phase=$secret;completed=@('database');detail=$secret;configurationHash=$secret;updatedAt='2026-08-21T00:00:00Z'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configRoot 'bootstrap-status.json') -Encoding utf8

    $exporter = Join-Path $PSScriptRoot 'Export-FORGE-Diagnostics.ps1'
    $exportParams = @{ InstallRoot = $installRoot; ConfigRoot = $configRoot; OutputPath = $archive }
    $published = & $exporter @exportParams
    if ($published -cne $archive) { throw 'Diagnostics returned an unexpected output path.' }

    $before = (Get-FileHash -LiteralPath $archive).Hash
    try {
        & $exporter @exportParams | Out-Null
        throw 'Diagnostics overwrote an existing archive without -Force.'
    } catch {
        if ($_.Exception.Message -ne 'The diagnostics archive already exists. Use -Force to replace it.') { throw }
    }
    if ((Get-FileHash -LiteralPath $archive).Hash -ne $before) { throw 'Diagnostics changed the archive without -Force.' }

    # Deny deletion while allowing readers, so the replacement must fail.
    $locked = [IO.File]::Open($archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        try {
            & $exporter @exportParams -Force | Out-Null
            throw 'Diagnostics replaced a locked archive.'
        } catch [System.IO.IOException] {}
    } finally { $locked.Dispose() }
    if ((Get-FileHash -LiteralPath $archive).Hash -ne $before) { throw 'Diagnostics changed the archive after a failed replacement.' }
    if (Get-ChildItem -LiteralPath $fixtureRoot -Filter '.forge-diagnostics-*.zip' -Force) { throw 'Diagnostics left a temporary ZIP after failure.' }

    [IO.File]::WriteAllText($archive, 'old output')
    & $exporter @exportParams -Force | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        if ($zip.Entries.Count -ne 2 -or
            @($zip.Entries | Where-Object FullName -CEQ 'diagnostics.json').Count -ne 1 -or
            @($zip.Entries | Where-Object FullName -CEQ 'README.txt').Count -ne 1) {
            throw 'Diagnostics ZIP must contain exactly diagnostics.json and README.txt.'
        }
        $content = @{}
        foreach ($entry in $zip.Entries) {
            $member = $entry.Open()
            try {
                $buffer = [IO.MemoryStream]::new()
                try {
                    $member.CopyTo($buffer)
                    $bytes = $buffer.ToArray()
                } finally { $buffer.Dispose() }
            } finally { $member.Dispose() }
            if ($entry.FullName -ceq 'diagnostics.json') {
                $content[$entry.FullName] = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
                if ($content[$entry.FullName].StartsWith([string][char]0xFEFF, [StringComparison]::Ordinal)) { throw 'Diagnostics JSON contains a UTF-8 BOM.' }
            } else {
                if ($bytes | Where-Object { $_ -gt 127 }) { throw 'Diagnostics README contains non-ASCII bytes.' }
                $content[$entry.FullName] = [Text.Encoding]::ASCII.GetString($bytes)
            }
        }
    } finally { $zip.Dispose() }
    $bundleText = $content.Values -join [Environment]::NewLine
    foreach ($forbidden in @($secret, $env:USERNAME, $env:COMPUTERNAME, $configRoot, 'configurationHash', 'privateNote')) {
        if (-not [string]::IsNullOrWhiteSpace($forbidden) -and $bundleText.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "Diagnostics leaked forbidden material: $forbidden" }
    }
    $json = $content['diagnostics.json'] | ConvertFrom-Json
    if (-not $json.configuration.valid -or -not $json.configuration.credentialPresent -or -not $json.configuration.precisionConfigured) { throw 'Diagnostics lost safe configuration health.' }
    if ($json.bootstrap.status -ne 'PASS' -or $json.bootstrap.completedPhaseCount -ne 1) { throw 'Diagnostics lost safe bootstrap health.' }
    if (-not $json.indexing.stale -or $json.indexing.status -ne 'PASS') { throw 'Diagnostics hid stale indexing.' }
    if ($null -ne $json.release.sourceCommit -or $null -ne $json.bootstrap.phase) { throw 'Diagnostics accepted an untrusted value in an allowlisted field.' }
    Write-Output 'PASS: diagnostics bundle is useful and allowlist-redacted.'
} finally { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
