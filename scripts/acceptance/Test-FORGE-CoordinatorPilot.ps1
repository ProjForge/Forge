[CmdletBinding()]
param([string]$PostgresBin='C:\Program Files\PostgreSQL\18\bin', [ValidateRange(1024,65535)][int]$Port=55441,
    [switch]$JointRestore, [switch]$LiveAgent, [string]$AgentBaseUrl='http://127.0.0.1:1234/v1', [string]$AgentModel='forge-agent-pilot-qwen35')
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runRoot=[IO.Path]::GetFullPath((Join-Path $workspace '.run'))
$root=[IO.Path]::GetFullPath((Join-Path $runRoot ('coordinator-pilot-'+[Guid]::NewGuid().ToString('N'))))
if (-not $root.StartsWith($runRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe pilot root' }
$started=$false
$names=@('FORGE_COORDINATOR_TEST_RESTORE','FORGE_COORDINATOR_TEST_PG_BIN','FORGE_DATABASE_URL','FORGE_ADMIN_DATABASE_URL','FORGE_RUNTIME_PASSWORD','FORGE_COORDINATOR_TEST_ADMIN_URL','FORGE_COORDINATOR_TEST_ALLOW_SETUP','FORGE_COORDINATOR_LIVE_BASE_URL','FORGE_COORDINATOR_LIVE_MODEL')
$previous=@{}
foreach ($name in $names) { $previous[$name]=[Environment]::GetEnvironmentVariable($name) }
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
@{status='RUNNING';checkedAt=[datetime]::UtcNow.ToString('o');scope='isolated coordinator pilot'} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'coordinator-pilot-result.json') -Encoding utf8
Push-Location $workspace
try {
    if ($JointRestore -and $LiveAgent) { throw 'Joint restore requires the synthetic provider' }
    if ($LiveAgent -and ([string]::IsNullOrWhiteSpace($AgentModel) -or [string]::IsNullOrWhiteSpace($AgentBaseUrl))) { throw 'Live agent model and loopback base URL must not be blank' }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $data=Join-Path $root 'data'
    & (Join-Path $PostgresBin 'initdb.exe') -D $data -U forge_pilot -A trust --locale=C --encoding=UTF8 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Pilot cluster initialization failed' }
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $data -l (Join-Path $root 'postgres.log') -o "-h 127.0.0.1 -p $Port" -w start
    if ($LASTEXITCODE -ne 0) { throw 'Pilot cluster startup failed' }
    $started=$true
    & (Join-Path $PostgresBin 'createdb.exe') -h 127.0.0.1 -p $Port -U forge_pilot forge_coordinator_pilot
    if ($LASTEXITCODE -ne 0) { throw 'Pilot database creation failed' }
    $env:FORGE_ADMIN_DATABASE_URL="postgresql://forge_pilot@127.0.0.1:$Port/forge_coordinator_pilot"
    $env:FORGE_DATABASE_URL=$env:FORGE_ADMIN_DATABASE_URL
    & node packages/schema/scripts/migrate.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Pilot Core migrations failed' }
    $env:FORGE_RUNTIME_PASSWORD=[Guid]::NewGuid().ToString('N')
    & node packages/schema/scripts/configure-runtime-role.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Pilot runtime role creation failed' }
    $env:FORGE_DATABASE_URL='postgresql://forge_runtime:{0}@127.0.0.1:{1}/forge_coordinator_pilot' -f $env:FORGE_RUNTIME_PASSWORD,$Port
    $env:FORGE_COORDINATOR_TEST_ADMIN_URL=$env:FORGE_ADMIN_DATABASE_URL
    $env:FORGE_COORDINATOR_TEST_ALLOW_SETUP='1'
    if ($LiveAgent) {
        $env:FORGE_COORDINATOR_LIVE_BASE_URL=$AgentBaseUrl
        $env:FORGE_COORDINATOR_LIVE_MODEL=$AgentModel
    } else {
        Remove-Item Env:FORGE_COORDINATOR_LIVE_BASE_URL,Env:FORGE_COORDINATOR_LIVE_MODEL -ErrorAction SilentlyContinue
    }
    $env:FORGE_COORDINATOR_TEST_RESTORE=if ($JointRestore) {'1'} else {'0'}
    $env:FORGE_COORDINATOR_TEST_PG_BIN=$PostgresBin
    & npm.cmd run build -w forge-persistence-gateway
    if ($LASTEXITCODE -ne 0) { throw 'Gateway build failed' }
    & npm.cmd run test:integration -w forge-coordinator
    if ($LASTEXITCODE -ne 0) { throw 'Coordinator pilot acceptance failed' }
    & npm.cmd run test:runtime-role -w forge-postgresql-schema
    if ($LASTEXITCODE -ne 0) { throw 'Core runtime privilege contract failed' }
} catch {
    @{status='FAIL';checkedAt=[datetime]::UtcNow.ToString('o');errorCode='COORDINATOR_PILOT_FAILED'} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'coordinator-pilot-result.json') -Encoding utf8
    throw
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$previous[$name]) }
    Pop-Location
    if ($started) {
        & (Join-Path $PostgresBin 'pg_ctl.exe') -D (Join-Path $root 'data') -m fast -w stop
        if ($LASTEXITCODE -ne 0) { throw 'Pilot cluster did not stop; its files were retained' }
    }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
@{status='PASS';checkedAt=[datetime]::UtcNow.ToString('o');clusterStopped=$true;liveAgent=[bool]$LiveAgent;model=if($LiveAgent){$AgentModel}else{'protocol-fixture'};scope='isolated coordinator acceptance; no production data or workers'} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'coordinator-pilot-result.json') -Encoding utf8
