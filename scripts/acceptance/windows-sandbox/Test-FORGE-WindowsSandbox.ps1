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
    Write-Output 'PASS: Clean-Windows acceptance is isolated, generic and shared by Sandbox and CI.'
} finally { Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue }
