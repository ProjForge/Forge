[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('forge-diagnostics-test-' + [Guid]::NewGuid().ToString('N'))
$secret = 'FORGE_TEST_SECRET_MUST_NOT_LEAK'
try {
    $installRoot = Join-Path $fixtureRoot 'installed'
    $configRoot = Join-Path $fixtureRoot 'config'
    $expanded = Join-Path $fixtureRoot 'expanded'
    $archive = Join-Path $fixtureRoot 'diagnostics.zip'
    New-Item -ItemType Directory -Path $installRoot, $configRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $installRoot 'FORGE-Workbench.exe'), 'fixture', [Text.UTF8Encoding]::new($false))
    [ordered]@{ product='FORGE Workbench'; version='0.2.0-rc.3'; sourceCommit=$secret } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installRoot 'RELEASE.json') -Encoding utf8
    [ordered]@{
        database=[ordered]@{host=$secret;port=5432;name=$secret;user=$secret;credentialFile='workbench.dpapi'}
        workbench=[ordered]@{port=7334}
        embedding=[ordered]@{model=$secret;rerankerModel='configured'}
        privateNote=$secret
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $configRoot 'workbench.json') -Encoding utf8
    $secret | Set-Content -LiteralPath (Join-Path $configRoot 'workbench.dpapi') -Encoding ascii
    [ordered]@{status='PASS';phase=$secret;completed=@('database');detail=$secret;configurationHash=$secret;updatedAt='2026-08-21T00:00:00Z'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configRoot 'bootstrap-status.json') -Encoding utf8

    & (Join-Path $PSScriptRoot 'Export-FORGE-Diagnostics.ps1') -InstallRoot $installRoot -ConfigRoot $configRoot -OutputPath $archive | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded
    $bundleText = Get-ChildItem -LiteralPath $expanded -File -Recurse | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName } | Out-String
    foreach ($forbidden in @($secret, $env:USERNAME, $env:COMPUTERNAME, $configRoot, 'configurationHash', 'privateNote')) {
        if (-not [string]::IsNullOrWhiteSpace($forbidden) -and $bundleText.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "Diagnostics leaked forbidden material: $forbidden" }
    }
    $json = Get-Content -Raw -LiteralPath (Join-Path $expanded 'diagnostics.json') | ConvertFrom-Json
    if (-not $json.configuration.valid -or -not $json.configuration.credentialPresent -or -not $json.configuration.precisionConfigured) { throw 'Diagnostics lost safe configuration health.' }
    if ($json.bootstrap.status -ne 'PASS' -or $json.bootstrap.completedPhaseCount -ne 1) { throw 'Diagnostics lost safe bootstrap health.' }
    if ($null -ne $json.release.sourceCommit -or $null -ne $json.bootstrap.phase) { throw 'Diagnostics accepted an untrusted value in an allowlisted field.' }
    Write-Output 'PASS: diagnostics bundle is useful and allowlist-redacted.'
} finally { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
