[CmdletBinding()]
param(
    [string]$SourceRoot = 'C:\FORGE\Input\Source',
    [string]$NodeRoot = 'C:\FORGE\Input\Node',
    [string]$PostgresRoot = 'C:\FORGE\Input\PostgreSQL',
    [string]$ReleaseRoot = 'C:\FORGE\Input\Release',
    [string]$OutputRoot = 'C:\FORGE\Output',
    [string]$WorkRoot = 'C:\FORGE\Lab',
    [string]$ExpectedVersion = '0.2.0-rc.4'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$startedAt = [DateTime]::UtcNow
$dataRoot = Join-Path $WorkRoot 'PostgreSQL-Data'
$postgresBin = Join-Path $PostgresRoot 'bin'
$configRoot = Join-Path $env:APPDATA 'FORGE'
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\FORGE Workbench'
$resultPath = Join-Path $OutputRoot 'lab-result.json'
$postgresPort = 55433
$workbenchPort = 7334
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
        releaseVersion = $ExpectedVersion
        url = "http://127.0.0.1:$workbenchPort"
        database = [ordered]@{ host='127.0.0.1'; port=$postgresPort; name='forge_lab'; fresh=$true }
        isolation = [ordered]@{ hostDatabaseTouched=$false; reset='Close Windows Sandbox' }
        checks = $checks
    }
    $temporary = "$resultPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $resultPath -Force
    } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

try {
    $releaseMetadataPath = Join-Path $ReleaseRoot 'RELEASE.json'
    foreach ($required in @(
        (Join-Path $SourceRoot 'scripts\install-forge-windows.ps1'),
        (Join-Path $SourceRoot 'node_modules\pg\package.json'),
        (Join-Path $SourceRoot 'packages\persistence-gateway\dist\index.js'),
        (Join-Path $NodeRoot 'node.exe'),
        (Join-Path $NodeRoot 'npm.cmd'),
        (Join-Path $postgresBin 'initdb.exe'),
        (Join-Path $PostgresRoot 'share\extension\vector.control'),
        (Join-Path $PostgresRoot 'lib\vector.dll'),
        (Join-Path $ReleaseRoot 'Install-FORGE-Workbench.ps1'),
        $releaseMetadataPath
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required read-only input is missing: $required" }
    }
    $release = Get-Content -Raw -LiteralPath $releaseMetadataPath | ConvertFrom-Json
    if ($release.product -ne 'FORGE Workbench' -or $release.version -ne $ExpectedVersion -or $release.platform -ne 'windows-x64') {
        throw 'Release metadata does not match the requested test candidate.'
    }
    $checks.verifiedPublicRelease = 'PASS'

    New-Item -ItemType Directory -Force -Path $WorkRoot, $OutputRoot | Out-Null
    $env:Path = "$NodeRoot;$postgresBin;$env:WINDIR\System32;$env:WINDIR"
    $pgCtl = Join-Path $postgresBin 'pg_ctl.exe'
    $initdb = Join-Path $postgresBin 'initdb.exe'

    & $initdb -D $dataRoot -U postgres --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale
    Assert-Exit 'Fresh PostgreSQL initialization'
    & $pgCtl -D $dataRoot -l (Join-Path $WorkRoot 'postgresql.log') -o "-p $postgresPort -h 127.0.0.1" start
    Assert-Exit 'Fresh PostgreSQL startup'
    $checks.freshPostgres = 'PASS'

    $adminPlain = New-RandomPassword
    $runtimePlain = New-RandomPassword
    $adminSecure = ConvertTo-SecureString $adminPlain -AsPlainText -Force
    $runtimeSecure = ConvertTo-SecureString $runtimePlain -AsPlainText -Force
    $bootstrap = Join-Path $SourceRoot 'scripts\install-forge-windows.ps1'
    & $bootstrap -DatabasePort $postgresPort -DatabaseName forge_lab -AdminPassword $adminSecure -RuntimePassword $runtimeSecure -SkipBuild -SkipWorkbench
    $bootstrapResult = Get-Content -Raw -LiteralPath (Join-Path $configRoot 'bootstrap-status.json') | ConvertFrom-Json
    if ($bootstrapResult.status -ne 'PASS') { throw 'Database bootstrap did not publish a PASS state.' }
    $checks.schemaBootstrap = 'PASS'

    & (Join-Path $ReleaseRoot 'Install-FORGE-Workbench.ps1') `
        -ConfigRoot $configRoot `
        -DatabasePort $postgresPort `
        -DatabaseName forge_lab `
        -DatabaseUser forge_runtime `
        -CredentialFile forge-runtime.dpapi `
        -WorkbenchPort $workbenchPort `
        -DatabasePassword $runtimeSecure `
        -NoLaunch
    $installedRelease = Get-Content -Raw -LiteralPath (Join-Path $installRoot 'RELEASE.json') | ConvertFrom-Json
    if ($installedRelease.version -ne $ExpectedVersion) { throw 'Installed Workbench version does not match the public release.' }
    $checks.installedPublicRelease = 'PASS'

    $workbenchExe = Join-Path $installRoot 'FORGE-Workbench.exe'
    Start-Process -FilePath $workbenchExe -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 500
        try { $bootstrapResponse = Invoke-RestMethod -Uri "http://127.0.0.1:$workbenchPort/api/bootstrap" -TimeoutSec 2 } catch { $bootstrapResponse = $null }
    } while (-not $bootstrapResponse -and (Get-Date) -lt $deadline)
    if (-not $bootstrapResponse.token) { throw 'Installed Workbench did not start on loopback.' }
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$workbenchPort/api/status" -Headers @{ 'x-forge-token' = $bootstrapResponse.token } -TimeoutSec 10
    if ($status.result.schemaVersion -ne '0.1.3' -or $status.result.vectorVersion -notmatch '^0\.8\.') { throw 'Workbench reported an incompatible fresh database.' }
    $checks.workbenchReady = 'PASS'

    $guide = @"
FORGE WORKBENCH TEST LAB

Release: $ExpectedVersion
Database: fresh and disposable

Suggested test:
1. Create a project.
2. Create a task, register and assign an agent, then change task status.
3. Add a memory and a decision.
4. Restart Workbench from the Start menu and verify that the data remains.
5. Resize the browser and test Inicio, Trabajo, Memoria and Recuperacion.

Reset: close the Windows Sandbox window. Nothing in this lab touches the host database.
"@
    $guidePath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FORGE Test Lab.txt'
    [IO.File]::WriteAllText($guidePath, $guide, [Text.UTF8Encoding]::new($false))
    Write-Result 'READY' 'The verified public Workbench is open against a fresh disposable PostgreSQL database.'
    Start-Process "http://127.0.0.1:$workbenchPort" | Out-Null
} catch {
    Write-Result 'FAIL' $_.Exception.Message
    $errorPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FORGE Test Lab - ERROR.txt'
    [IO.File]::WriteAllText($errorPath, "FORGE test lab setup failed.`r`n`r`n$($_.Exception.Message)", [Text.UTF8Encoding]::new($false))
    Start-Process notepad.exe -ArgumentList ('"' + $errorPath + '"') | Out-Null
    exit 1
} finally {
    $adminPlain = $null
    $runtimePlain = $null
    $adminSecure = $null
    $runtimeSecure = $null
}
