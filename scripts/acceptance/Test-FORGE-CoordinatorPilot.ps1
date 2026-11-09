[CmdletBinding()]
param([string]$PostgresBin='C:\Program Files\PostgreSQL\18\bin', [ValidateRange(1024,65535)][int]$Port=55441,
    [switch]$SplitDatabaseRestore, [switch]$FreshClusterRestore, [switch]$JointRestore, [switch]$LiveAgent, [string]$AgentBaseUrl='http://127.0.0.1:1234/v1', [string]$AgentModel='forge-agent-pilot-qwen35')
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runRoot=[IO.Path]::GetFullPath((Join-Path $workspace '.run'))
$root=[IO.Path]::GetFullPath((Join-Path $runRoot ('coordinator-pilot-'+[Guid]::NewGuid().ToString('N'))))
if (-not $root.StartsWith($runRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe pilot root' }
$started=$false
$targetStarted=$false
# Obtain unused generated loopback ports for the two-cluster drill only.
function Get-FixturePort {
    $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
    $listener.Start()
    try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
if ($SplitDatabaseRestore -and ($FreshClusterRestore -or $JointRestore -or $LiveAgent)) { throw 'SplitDatabaseRestore is a separate synthetic-only mode' }
if ($FreshClusterRestore -or $SplitDatabaseRestore) {
    if ($LiveAgent -or $JointRestore) { throw 'FreshClusterRestore is a separate synthetic-only mode' }
    $Port=Get-FixturePort
    do { $targetPort=Get-FixturePort } while ($targetPort -eq $Port)
}

function Initialize-FixtureTarget {
    param([string]$root,[string]$PostgresBin,[int]$targetPort,[string]$adminPassword)
        $targetData=Join-Path $root 'target-data'
        $passwordFile=Join-Path $root 'target-init-password'
        # Create with an owner-only ACL before writing any synthetic secret bytes.
        $acl=New-Object Security.AccessControl.FileSecurity
        $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.SetOwner($owner)
        $acl.SetAccessRuleProtection($true,$false)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($owner,'FullControl','Allow')))
        $passwordStream=[IO.File]::Create($passwordFile,4096,[IO.FileOptions]::None,$acl)
        try {
            $passwordBytes=[Text.Encoding]::UTF8.GetBytes($adminPassword+"`n")
            $passwordStream.Write($passwordBytes,0,$passwordBytes.Length)
        } finally { $passwordStream.Dispose() }
        try {
            & (Join-Path $PostgresBin 'initdb.exe') -D $targetData -U forge_pilot -A scram-sha-256 --pwfile=$passwordFile --locale=C --encoding=UTF8 | Out-Null
        } finally { Remove-Item -LiteralPath $passwordFile -Force }
        if ($LASTEXITCODE -ne 0) { throw 'Target initialization failed' }
        & (Join-Path $PostgresBin 'pg_ctl.exe') -D $targetData -l (Join-Path $root 'target.log') -o "-h 127.0.0.1 -p $targetPort" -w start
        if ($LASTEXITCODE -ne 0) { throw 'Target startup failed' }
}

$names=@('FORGE_COORDINATOR_TEST_ROOT','FORGE_COORDINATOR_TEST_PROVISION_HASH','FORGE_COORDINATOR_TEST_SPLIT','FORGE_COORDINATOR_TEST_STATE_ADMIN','FORGE_COORDINATOR_TEST_PROVISION','FORGE_COORDINATOR_TEST_FRESH_TARGET','FORGE_COORDINATOR_TEST_RESTORE','FORGE_COORDINATOR_TEST_PG_BIN','FORGE_DATABASE_URL','FORGE_ADMIN_DATABASE_URL','FORGE_RUNTIME_PASSWORD','FORGE_COORDINATOR_TEST_ADMIN_URL','FORGE_COORDINATOR_TEST_ALLOW_SETUP','FORGE_COORDINATOR_LIVE_BASE_URL','FORGE_COORDINATOR_LIVE_MODEL')
$previous=@{}
foreach ($name in $names) { $previous[$name]=[Environment]::GetEnvironmentVariable($name) }
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
@{status='RUNNING';checkedAt=[datetime]::UtcNow.ToString('o');scope='isolated coordinator pilot'} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'coordinator-pilot-result.json') -Encoding utf8
Push-Location $workspace
try {
    # libpq hostaddr/service defaults can override an explicit -h. Keep them inert
    # through cleanup, then restore the caller's complete PG environment.
    $pgPrevious=@{}
    if ($SplitDatabaseRestore) {
        Get-ChildItem Env: | Where-Object { $_.Name -like 'PG*' } | ForEach-Object {
            $pgPrevious[$_.Name]=$_.Value
            [Environment]::SetEnvironmentVariable($_.Name,$null)
        }
        $env:FORGE_COORDINATOR_TEST_ROOT=$root
    }
    if (($FreshClusterRestore -or $SplitDatabaseRestore) -and (& (Join-Path $PostgresBin 'postgres.exe') --version) -notmatch '18\.4(?:\D|$)') { throw 'Fresh cluster rehearsal requires PostgreSQL 18.4' }
    if ($JointRestore -and $LiveAgent) { throw 'Joint restore requires the synthetic provider' }
    if ($LiveAgent -and ([string]::IsNullOrWhiteSpace($AgentModel) -or [string]::IsNullOrWhiteSpace($AgentBaseUrl))) { throw 'Live agent model and loopback base URL must not be blank' }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $data=Join-Path $root 'data'
    & (Join-Path $PostgresBin 'initdb.exe') -D $data -U forge_pilot -A trust --locale=C --encoding=UTF8 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Pilot cluster initialization failed' }
    $started=$true # Startup failure can still leave an owned server running.
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $data -l (Join-Path $root 'postgres.log') -o "-h 127.0.0.1 -p $Port" -w start
    if ($LASTEXITCODE -ne 0) { throw 'Pilot cluster startup failed' }
    $started=$true
    if ($SplitDatabaseRestore) {
        $identity=& (Join-Path $PostgresBin 'psql.exe') -X -w -h 127.0.0.1 -p $Port -U forge_pilot -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT current_setting('data_directory'),inet_server_addr(),inet_server_port(),current_database(),current_user"
        if ($LASTEXITCODE -ne 0) { throw 'Source preflight failed' }
        $parts=($identity -join '').Split('|')
        if ($parts.Count -ne 5 -or -not [IO.Path]::GetFullPath($parts[0]).Equals([IO.Path]::GetFullPath($data),[StringComparison]::OrdinalIgnoreCase) -or $parts[1] -ne '127.0.0.1' -or $parts[2] -ne "$Port" -or $parts[3] -ne 'postgres' -or $parts[4] -ne 'forge_pilot') { throw 'Source fixture identity mismatch' }
    }
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
    if ($SplitDatabaseRestore) {
        & (Join-Path $PostgresBin 'createdb.exe') -h 127.0.0.1 -p $Port -U forge_pilot forge_coordinator_state
        if ($LASTEXITCODE -ne 0) { throw 'State database creation failed' }
        $env:FORGE_COORDINATOR_TEST_STATE_ADMIN="postgresql://forge_pilot@127.0.0.1:$Port/forge_coordinator_state"
    } else { Remove-Item Env:FORGE_COORDINATOR_TEST_STATE_ADMIN,Env:FORGE_COORDINATOR_TEST_PROVISION -ErrorAction SilentlyContinue }
    if ($LiveAgent) {
        $env:FORGE_COORDINATOR_LIVE_BASE_URL=$AgentBaseUrl
        $env:FORGE_COORDINATOR_LIVE_MODEL=$AgentModel
    } else {
        Remove-Item Env:FORGE_COORDINATOR_LIVE_BASE_URL,Env:FORGE_COORDINATOR_LIVE_MODEL -ErrorAction SilentlyContinue
    }
    if ($FreshClusterRestore -or $SplitDatabaseRestore) {
        $adminPassword=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
        $targetStarted=$true # A partial startup must still be stopped in finally.
        if ($SplitDatabaseRestore) {
            $provision=Join-Path $root 'provision-target.ps1'
            $header='$ErrorActionPreference="Stop"; $target=[uri]$env:FORGE_COORDINATOR_TEST_FRESH_TARGET; '
            $header+='$root=Split-Path -Parent $PSCommandPath; $PostgresBin=$env:FORGE_COORDINATOR_TEST_PG_BIN; $targetPort=$target.Port; $adminPassword=$target.UserInfo.Split(":")[1]; '
            ($header+(${function:Initialize-FixtureTarget}.ToString() -replace '(?s)^.*?param\([^\n]*\)\s*','')) | Set-Content -LiteralPath $provision -Encoding UTF8
            $hasher=[Security.Cryptography.SHA256]::Create()
            try { $env:FORGE_COORDINATOR_TEST_PROVISION_HASH=([BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($provision)))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
            $env:FORGE_COORDINATOR_TEST_PROVISION=$provision
        } else { Initialize-FixtureTarget $root $PostgresBin $targetPort $adminPassword }
        $env:FORGE_COORDINATOR_TEST_FRESH_TARGET="postgresql://forge_pilot:${adminPassword}@127.0.0.1:$targetPort/postgres"
    } else { Remove-Item Env:FORGE_COORDINATOR_TEST_FRESH_TARGET -ErrorAction SilentlyContinue }
    $env:FORGE_COORDINATOR_TEST_SPLIT=if ($SplitDatabaseRestore) {'1'} else {'0'}
    $env:FORGE_COORDINATOR_TEST_RESTORE=if ($JointRestore -or $FreshClusterRestore -or $SplitDatabaseRestore) {'1'} else {'0'}
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
    $stopFailures=@()
    # Each owned cluster must be attempted even when the other stop fails.
    foreach ($cluster in @(@{active=$targetStarted;directory='target-data'},@{active=$started;directory='data'})) {
        if ($cluster.active -and (Test-Path -LiteralPath (Join-Path $root $cluster.directory))) {
            try {
                & (Join-Path $PostgresBin 'pg_ctl.exe') -D (Join-Path $root $cluster.directory) -m fast -w stop
                if ($LASTEXITCODE -ne 0) { throw 'Stop unconfirmed' }
            } catch { $stopFailures += $cluster.directory }
        }
    }
    foreach ($name in $pgPrevious.Keys) { [Environment]::SetEnvironmentVariable($name,$pgPrevious[$name]) }
    if ($stopFailures.Count -gt 0) { throw ('Cluster stop unconfirmed; all fixture files retained: '+($stopFailures -join ', ')) }
    if (-not $root.StartsWith($runRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup root' }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
@{splitDatabaseRestore=[bool]$SplitDatabaseRestore;status='PASS';checkedAt=[datetime]::UtcNow.ToString('o');clusterStopped=$true;targetClusterStopped=[bool]($FreshClusterRestore -or $SplitDatabaseRestore);freshClusterRestore=[bool]$FreshClusterRestore;liveAgent=[bool]$LiveAgent;model=if($LiveAgent){$AgentModel}else{'protocol-fixture'};scope='isolated coordinator acceptance; no production data or workers'} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'coordinator-pilot-result.json') -Encoding utf8
