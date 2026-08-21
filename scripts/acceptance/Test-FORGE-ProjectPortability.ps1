[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 55435,
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$clusterRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('forge-portability-pg-' + [guid]::NewGuid().ToString('N'))
$databaseUrl = "postgresql://postgres@127.0.0.1:$Port/forge_portability"
$started = $false

function Invoke-PostgresTool {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string[]]$Arguments)
    $tool = Join-Path $PostgresBin "$Name.exe"
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "PostgreSQL tool was not found: $tool" }
    & $tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

try {
    New-Item -ItemType Directory -Path $clusterRoot | Out-Null
    Invoke-PostgresTool 'initdb' @('-D', $clusterRoot, '--auth=trust', '--username=postgres', '--encoding=UTF8', '--no-locale')
    Invoke-PostgresTool 'pg_ctl' @('-D', $clusterRoot, '-o', "-p $Port -h 127.0.0.1", '-w', 'start')
    $started = $true
    Invoke-PostgresTool 'createdb' @('-h', '127.0.0.1', '-p', [string]$Port, '-U', 'postgres', 'forge_portability')

    Push-Location $repoRoot
    try {
        $env:FORGE_DATABASE_URL = $databaseUrl
        & 'C:\Program Files\nodejs\node.exe' 'packages/schema/scripts/migrate.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'FORGE schema migration failed.' }
        & 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' run test:integration -w forge-persistence-gateway
        if ($LASTEXITCODE -ne 0) { throw 'Project portability integration test failed.' }
        & 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' run build -w forge-persistence-gateway
        if ($LASTEXITCODE -ne 0) { throw 'Gateway build failed.' }
        & 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' run build -w forge-workbench
        if ($LASTEXITCODE -ne 0) { throw 'Workbench build failed.' }
        & 'C:\Program Files\nodejs\node.exe' 'scripts/acceptance/test-project-portability-http.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'Workbench portability HTTP acceptance failed.' }
    }
    finally {
        Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
        Pop-Location
    }
}
finally {
    if ($started) {
        Invoke-PostgresTool 'pg_ctl' @('-D', $clusterRoot, '-m', 'fast', '-w', 'stop')
    }
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedCluster = [System.IO.Path]::GetFullPath($clusterRoot)
    if (-not $resolvedCluster.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($resolvedCluster)).StartsWith('forge-portability-pg-', [System.StringComparison]::Ordinal)) {
        throw "Refusing to remove unexpected cluster path: $resolvedCluster"
    }
    Remove-Item -LiteralPath $resolvedCluster -Recurse -Force -ErrorAction SilentlyContinue
}
