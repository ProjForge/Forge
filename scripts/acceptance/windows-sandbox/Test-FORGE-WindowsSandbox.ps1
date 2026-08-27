[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$output = Join-Path ([IO.Path]::GetTempPath()) ('forge-sandbox-plan-' + [Guid]::NewGuid().ToString('N'))
try {
    $plan = & (Join-Path $PSScriptRoot 'Start-FORGE-WindowsSandbox.ps1') -RepositoryRoot $repositoryRoot -OutputRoot $output -PlanOnly | ConvertFrom-Json
    if (-not $plan.safe -or $plan.mode -ne 'plan' -or -not $plan.sourceReadOnly -or -not $plan.freshPostgresData -or $plan.hostDatabaseTouched) {
        throw 'Windows Sandbox acceptance plan violates isolation requirements.'
    }
    if (Test-Path -LiteralPath $output) { throw 'Plan mode changed the filesystem.' }
    $missingRootPlan = & (Join-Path $PSScriptRoot 'Start-FORGE-WindowsSandbox.ps1') `
        -RepositoryRoot $repositoryRoot `
        -NodeRoot (Join-Path $output 'missing-node') `
        -PostgresRoot (Join-Path $output 'missing-postgresql') `
        -OutputRoot $output `
        -PlanOnly | ConvertFrom-Json
    if (-not $missingRootPlan.safe -or $missingRootPlan.mode -ne 'plan') {
        throw 'Plan mode requires host runtime binaries that it must not execute.'
    }
    if (Test-Path -LiteralPath $output) { throw 'Plan mode changed the filesystem.' }
    $source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Invoke-FORGE-Acceptance.ps1')
    if ($source -match '(?im)^\s*\$(?:admin|runtime)(?:password|plain)\s*=\s*[''\"]' -or
        $source -match '(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b') {
        throw 'Acceptance script contains a hardcoded secret or project identifier.'
    }
    if ($source -notmatch 'EnvironmentLabel' -or $source -notmatch 'Clean Windows bootstrap') {
        throw 'The acceptance body is coupled to one clean-Windows executor.'
    }
    $workflow = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot '.github\workflows\ci.yml')
    if ($workflow -notmatch 'windows-clean-bootstrap' -or $workflow -notmatch 'windows-2022' -or $workflow -notmatch 'Invoke-FORGE-Acceptance.ps1') {
        throw 'CI does not execute the shared acceptance body on an ephemeral Windows runner.'
    }
    $labPlan = & (Join-Path $PSScriptRoot 'Start-FORGE-WorkbenchTestLab.ps1') `
        -RepositoryRoot $repositoryRoot `
        -NodeRoot (Join-Path $output 'missing-node') `
        -PostgresRoot (Join-Path $output 'missing-postgresql') `
        -OutputRoot $output `
        -PlanOnly | ConvertFrom-Json
    if (-not $labPlan.safe -or $labPlan.mode -ne 'plan' -or -not $labPlan.publicArtifactVerified -or
        -not $labPlan.releaseReadOnly -or -not $labPlan.freshPostgresData -or $labPlan.hostDatabaseTouched -or
        $labPlan.networking -ne 'disabled-in-sandbox' -or $labPlan.reset -ne 'Close Windows Sandbox') {
        throw 'Interactive Workbench lab plan violates isolation or artifact-verification requirements.'
    }
    if (Test-Path -LiteralPath $output) { throw 'Interactive lab plan mode changed the filesystem.' }
    $labHost = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Start-FORGE-WorkbenchTestLab.ps1')
    $labGuest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Invoke-FORGE-WorkbenchTestLab.ps1')
    if ($labHost -notmatch 'Get-FileHash' -or $labHost -notmatch '<Networking>Disable</Networking>' -or
        $labHost -notmatch '<ReadOnly>true</ReadOnly>' -or $labGuest -notmatch '-SkipBuild -SkipWorkbench' -or
        $labGuest -notmatch 'installedRelease.version' -or $labGuest -notmatch "Write-Result 'READY'") {
        throw 'Interactive Workbench lab does not verify and install the pinned release in an isolated guest.'
    }
    if (($labHost + $labGuest) -match '(?im)^\s*\$(?:admin|runtime)(?:password|plain)\s*=\s*[''"]' -or
        ($labHost + $labGuest) -match '(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b') {
        throw 'Interactive Workbench lab contains a hardcoded secret or project identifier.'
    }
    $localLab = Join-Path $repositoryRoot 'scripts\acceptance\Start-FORGE-WorkbenchLocalTestLab.ps1'
    $localPlan = & $localLab `
        -RepositoryRoot $repositoryRoot `
        -NodeRoot (Join-Path $output 'missing-node') `
        -PostgresRoot (Join-Path $output 'missing-postgresql') `
        -CacheRoot (Join-Path $output 'missing-cache') `
        -PlanOnly | ConvertFrom-Json
    if (-not $localPlan.safe -or $localPlan.mode -ne 'plan' -or -not $localPlan.publicArtifactVerified -or
        -not $localPlan.freshPostgresData -or -not $localPlan.isolatedConfiguration -or
        -not $localPlan.isolatedInstallation -or $localPlan.hostDatabaseTouched) {
        throw 'Local Workbench fallback plan violates isolation or artifact-verification requirements.'
    }
    if (Test-Path -LiteralPath $output) { throw 'Local lab plan mode changed the filesystem.' }
    $localSource = Get-Content -Raw -LiteralPath $localLab
    if ($localSource -notmatch 'Get-FileHash' -or $localSource -notmatch '-NoShortcuts -NoLaunch' -or
        $localSource -notmatch 'FORGE-Workbench-Local-Lab-' -or $localSource -notmatch 'Remove-Item -LiteralPath \$resolvedLab') {
        throw 'Local Workbench fallback does not verify, isolate and erase its disposable state.'
    }
    Write-Output 'PASS: Clean-Windows acceptance and both interactive Workbench labs are isolated, generic and reproducible.'
} finally { Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue }
