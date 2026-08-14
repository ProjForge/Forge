[CmdletBinding()]
param(
    [string]$SourceRoot = 'C:\FORGE\Input\Source',
    [string]$NodeRoot = 'C:\FORGE\Input\Node',
    [string]$PostgresRoot = 'C:\FORGE\Input\PostgreSQL',
    [string]$OutputRoot = 'C:\FORGE\Output',
    [string]$WorkRoot = 'C:\FORGE\Acceptance',
    [string]$EnvironmentLabel = 'Windows Sandbox'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$startedAt = [DateTime]::UtcNow
$repositoryRoot = Join-Path $workRoot 'Source'
$dataRoot = Join-Path $workRoot 'PostgreSQL-Data'
$postgresBin = Join-Path $PostgresRoot 'bin'
$configRoot = Join-Path $env:APPDATA 'FORGE'
$resultPath = Join-Path $OutputRoot 'acceptance-result.json'
$postgresPort = 55433
$workbenchProcess = $null
$postgresStarted = $false
$adminPlain = $null
$runtimePlain = $null
$checks = [ordered]@{}

function Assert-Exit([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE." }
}

function New-RandomPassword {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes); return ([Convert]::ToBase64String($bytes) + '!aA1') }
    finally { $rng.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length) }
}

function New-DatabaseUrl([string]$User, [string]$Password, [string]$Database) {
    return 'postgresql://{0}:{1}@127.0.0.1:{2}/{3}' -f [Uri]::EscapeDataString($User), [Uri]::EscapeDataString($Password), $postgresPort, [Uri]::EscapeDataString($Database)
}

function Write-Result([string]$Status, [string]$Detail) {
    New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
    $safeDetail = ($Detail -replace 'postgresql://[^:@/\s]+:[^@/\s]+@', 'postgresql://***:***@')
    if ($safeDetail.Length -gt 512) { $safeDetail = $safeDetail.Substring(0, 512) }
    $result = [ordered]@{
        version = 1
        status = $Status
        detail = $safeDetail
        startedAt = $startedAt.ToString('o')
        completedAt = [DateTime]::UtcNow.ToString('o')
        environment = [ordered]@{
            host = $EnvironmentLabel
            os = [Environment]::OSVersion.VersionString
            node = if (Test-Path (Join-Path $NodeRoot 'node.exe')) { (& (Join-Path $NodeRoot 'node.exe') --version) } else { 'missing' }
            postgres = if (Test-Path (Join-Path $postgresBin 'psql.exe')) { (& (Join-Path $postgresBin 'psql.exe') --version) } else { 'missing' }
        }
        checks = $checks
    }
    $temporary = "$resultPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $resultPath -Force
    } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

try {
    foreach ($required in @(
        (Join-Path $SourceRoot 'scripts\install-forge-windows.ps1'),
        (Join-Path $NodeRoot 'node.exe'),
        (Join-Path $NodeRoot 'npm.cmd'),
        (Join-Path $postgresBin 'initdb.exe'),
        (Join-Path $PostgresRoot 'share\extension\vector.control'),
        (Join-Path $PostgresRoot 'lib\vector.dll')
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required read-only input is missing: $required" }
    }
    $checks.inputs = 'PASS'

    New-Item -ItemType Directory -Force -Path $workRoot, $OutputRoot | Out-Null
    & robocopy.exe $SourceRoot $repositoryRoot /E /NFL /NDL /NJH /NJS /NP /XD .git node_modules dist .test-dist .run | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Source isolation copy failed with exit code $LASTEXITCODE." }
    $checks.cleanSourceCopy = 'PASS'

    $env:Path = "$NodeRoot;$postgresBin;$env:WINDIR\System32;$env:WINDIR"
    $node = Join-Path $NodeRoot 'node.exe'
    $npm = Join-Path $NodeRoot 'npm.cmd'
    $pgCtl = Join-Path $postgresBin 'pg_ctl.exe'
    $psql = Join-Path $postgresBin 'psql.exe'
    $initdb = Join-Path $postgresBin 'initdb.exe'

    & $initdb -D $dataRoot -U postgres --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale
    Assert-Exit 'Fresh PostgreSQL initialization'
    & $pgCtl -D $dataRoot -l (Join-Path $workRoot 'postgresql.log') -o "-p $postgresPort -h 127.0.0.1" start
    Assert-Exit 'Fresh PostgreSQL startup'
    $postgresStarted = $true
    $checks.freshPostgres = 'PASS'

    $adminPlain = New-RandomPassword
    $runtimePlain = New-RandomPassword
    $adminSecure = ConvertTo-SecureString $adminPlain -AsPlainText -Force
    $runtimeSecure = ConvertTo-SecureString $runtimePlain -AsPlainText -Force
    $installer = Join-Path $repositoryRoot 'scripts\install-forge-windows.ps1'

    $plan = & $installer -DatabasePort $postgresPort -DatabaseName forge_acceptance -AdminPassword $adminSecure -RuntimePassword $runtimeSecure -PlanOnly | ConvertFrom-Json
    if (-not $plan.safe -or $plan.mode -ne 'plan') { throw 'Bootstrap plan was not safe.' }
    $checks.plan = 'PASS'

    & $installer -DatabasePort $postgresPort -DatabaseName forge_acceptance -AdminPassword $adminSecure -RuntimePassword $runtimeSecure
    $bootstrap = Get-Content -Raw -LiteralPath (Join-Path $configRoot 'bootstrap-status.json') | ConvertFrom-Json
    if ($bootstrap.status -ne 'PASS' -or $bootstrap.phase -ne 'complete') { throw 'Bootstrap did not publish a complete PASS state.' }
    $checks.bootstrap = 'PASS'

    Push-Location $repositoryRoot
    try {
        & $npm run check
        Assert-Exit 'Complete monorepo validation'
        $runtimeUrl = New-DatabaseUrl 'forge_runtime' $runtimePlain 'forge_acceptance'
        $env:FORGE_DATABASE_URL = $runtimeUrl
        & $npm run test:integration -w forge-mcp-server
        Assert-Exit 'MCP continuity validation'
        Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
        $mcp = & $node 'packages\mcp-server\scripts\check-codex-registration.mjs' | ConvertFrom-Json
        if ($mcp.status -ne 'PASS' -or $mcp.tools -ne 27 -or $mcp.schemaVersion -ne '0.1.3') { throw 'DPAPI MCP launcher validation failed.' }
    } finally { Pop-Location; Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue }
    $checks.mcpContinuity = 'PASS'

    $workbenchExe = Join-Path $env:LOCALAPPDATA 'Programs\FORGE Workbench\FORGE-Workbench.exe'
    if (-not (Test-Path -LiteralPath $workbenchExe -PathType Leaf)) { throw 'Installed Workbench executable is missing.' }
    $workbenchProcess = Start-Process -FilePath $workbenchExe -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 500
        try { $bootstrapResponse = Invoke-RestMethod -Uri 'http://127.0.0.1:7334/api/bootstrap' -TimeoutSec 2 } catch { $bootstrapResponse = $null }
    } while (-not $bootstrapResponse -and (Get-Date) -lt $deadline)
    if (-not $bootstrapResponse.token) { throw 'Installed Workbench did not start on loopback.' }
    $workbenchStatus = Invoke-RestMethod -Uri 'http://127.0.0.1:7334/api/status' -Headers @{ 'x-forge-token' = $bootstrapResponse.token } -TimeoutSec 10
    if ($workbenchStatus.result.schemaVersion -ne '0.1.3' -or $workbenchStatus.result.vectorVersion -notmatch '^0\.8\.') { throw 'Installed Workbench reported an incompatible database.' }
    $checks.workbench = 'PASS'

    Stop-Process -Id $workbenchProcess.Id -Force -ErrorAction SilentlyContinue
    $workbenchProcess = $null
    & $pgCtl -D $dataRoot restart -m fast
    Assert-Exit 'PostgreSQL restart'
    Push-Location $repositoryRoot
    try {
        $mcpAfterRestart = & $node 'packages\mcp-server\scripts\check-codex-registration.mjs' | ConvertFrom-Json
        if ($mcpAfterRestart.status -ne 'PASS') { throw 'MCP did not recover after PostgreSQL restart.' }
    } finally { Pop-Location }
    $checks.persistenceAfterRestart = 'PASS'

    & $installer -DatabasePort $postgresPort -DatabaseName forge_acceptance -Resume
    $resumed = Get-Content -Raw -LiteralPath (Join-Path $configRoot 'bootstrap-status.json') | ConvertFrom-Json
    if ($resumed.status -ne 'PASS') { throw 'Idempotent resume did not pass.' }
    $checks.resume = 'PASS'

    & $installer -DatabasePort $postgresPort -DatabaseName forge_acceptance -Rollback
    if (Test-Path -LiteralPath (Split-Path -Parent $workbenchExe)) { throw 'Rollback left the Workbench installation behind.' }
    if (-not (Test-Path -LiteralPath (Join-Path $configRoot 'workbench.json') -PathType Leaf)) { throw 'Rollback removed preserved user configuration.' }
    $tableCount = & $psql -X -At -h 127.0.0.1 -p $postgresPort -U postgres -d forge_acceptance -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'forge'"
    Assert-Exit 'Rollback persistence query'
    if ([int]$tableCount -lt 10) { throw 'Rollback removed durable database objects.' }
    $checks.dataPreservingRollback = 'PASS'

    Write-Result 'PASS' 'Clean Windows bootstrap, clients, restart continuity, resume and data-preserving rollback passed.'
    Write-Host 'FORGE CLEAN WINDOWS ACCEPTANCE: PASS' -ForegroundColor Green
} catch {
    Write-Result 'FAIL' $_.Exception.Message
    Write-Host "FORGE CLEAN WINDOWS ACCEPTANCE: FAIL - $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($workbenchProcess) { Stop-Process -Id $workbenchProcess.Id -Force -ErrorAction SilentlyContinue }
    if ($postgresStarted) { & (Join-Path $postgresBin 'pg_ctl.exe') -D $dataRoot stop -m fast 2>$null | Out-Null }
    Remove-Item Env:FORGE_DATABASE_URL -ErrorAction SilentlyContinue
    $adminPlain = $null
    $runtimePlain = $null
    $adminSecure = $null
    $runtimeSecure = $null
}
