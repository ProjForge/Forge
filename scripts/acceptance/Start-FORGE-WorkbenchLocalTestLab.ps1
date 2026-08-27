[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [string]$NodeRoot,
    [string]$PostgresRoot,
    [string]$ReleaseArchive,
    [string]$CacheRoot,
    [string]$ReleaseVersion = '0.2.0-rc.5',
    [string]$ReleaseSha256 = 'D19764183B30BDB1FCE867D9B95221DDA83448F5E5667532FED6F1271072B35D',
    [ValidateRange(1, 65535)][int]$DatabasePort = 55433,
    [ValidateRange(1, 65535)][int]$WorkbenchPort = 17334,
    [switch]$PlanOnly,
    [switch]$KeepLab
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
if ([string]::IsNullOrWhiteSpace($NodeRoot)) {
    $node = Get-Command node.exe -ErrorAction Stop
    $NodeRoot = Split-Path -Parent $node.Source
}
if ([string]::IsNullOrWhiteSpace($PostgresRoot)) {
    $candidates = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction Stop |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\initdb.exe') } |
        Sort-Object { [int]$_.Name } -Descending
    if (-not $candidates) { throw 'A local PostgreSQL installation was not found.' }
    $PostgresRoot = $candidates[0].FullName
}
if ([string]::IsNullOrWhiteSpace($CacheRoot)) { $CacheRoot = Join-Path $RepositoryRoot '.run\release-cache' }
if ($ReleaseVersion -notmatch '^\d+\.\d+\.\d+(?:-rc\.\d+)?$') { throw 'ReleaseVersion is invalid.' }
if ($ReleaseSha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'ReleaseSha256 must be a SHA-256 digest.' }

$plan = [ordered]@{
    safe = $true
    mode = if ($PlanOnly) { 'plan' } else { 'interactive-local-lab' }
    releaseVersion = $ReleaseVersion
    publicArtifactVerified = $true
    freshPostgresData = $true
    isolatedConfiguration = $true
    isolatedInstallation = $true
    hostDatabaseTouched = $false
    databasePort = $DatabasePort
    workbenchPort = $WorkbenchPort
    reset = 'Press Enter in the launcher'
    limitation = 'Host Windows and browser are shared; use Windows Sandbox or a VM for OS/SmartScreen acceptance.'
}
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 5; return }

foreach ($port in @($DatabasePort, $WorkbenchPort)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "Port $port is already in use." }
}
$required = [ordered]@{
    bootstrap = Join-Path $RepositoryRoot 'scripts\install-forge-windows.ps1'
    dependencies = Join-Path $RepositoryRoot 'node_modules\pg\package.json'
    gatewayBuild = Join-Path $RepositoryRoot 'packages\persistence-gateway\dist\index.js'
    node = Join-Path $NodeRoot 'node.exe'
    npm = Join-Path $NodeRoot 'npm.cmd'
    postgres = Join-Path $PostgresRoot 'bin\initdb.exe'
    pgvectorControl = Join-Path $PostgresRoot 'share\extension\vector.control'
    pgvectorDll = Join-Path $PostgresRoot 'lib\vector.dll'
}
foreach ($entry in $required.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) { throw "Missing $($entry.Key) input: $($entry.Value)" }
}

function New-RandomPassword {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes); return ([Convert]::ToBase64String($bytes) + '!aA1') }
    finally { $rng.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length) }
}

$archiveName = "FORGE-Workbench-$ReleaseVersion-Windows-x64.zip"
$releaseUrl = "https://github.com/ProjForge/Forge/releases/download/v$ReleaseVersion/$archiveName"
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$archivePath = Join-Path $CacheRoot $archiveName
New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
if (-not [string]::IsNullOrWhiteSpace($ReleaseArchive)) {
    $archivePath = [IO.Path]::GetFullPath($ReleaseArchive)
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Release archive was not found: $archivePath" }
} elseif (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    Write-Host "Downloading pinned FORGE Workbench $ReleaseVersion artifact..."
    Invoke-WebRequest -Uri $releaseUrl -OutFile $archivePath -UseBasicParsing
}
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actualHash -ne $ReleaseSha256.ToUpperInvariant()) {
    throw "Release archive SHA-256 mismatch. Expected $($ReleaseSha256.ToUpperInvariant()), received $actualHash."
}

$labRoot = Join-Path ([IO.Path]::GetTempPath()) ('FORGE-Workbench-Local-Lab-' + [Guid]::NewGuid().ToString('N'))
$dataRoot = Join-Path $labRoot 'PostgreSQL-Data'
$distributionRoot = Join-Path $labRoot 'Release'
$profileRoot = Join-Path $labRoot 'Profile'
$configRoot = Join-Path $profileRoot 'Roaming\FORGE'
$installRoot = Join-Path $labRoot 'Application'
$postgresBin = Join-Path $PostgresRoot 'bin'
$pgCtl = Join-Path $postgresBin 'pg_ctl.exe'
$workbenchProcess = $null
$postgresStarted = $false
$adminPlain = $null
$runtimePlain = $null
$previousPath = $env:Path
$previousAppData = $env:APPDATA
$previousLocalAppData = $env:LOCALAPPDATA

try {
    New-Item -ItemType Directory -Force -Path $labRoot, $profileRoot | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $distributionRoot
    $releaseMetadata = Get-ChildItem -LiteralPath $distributionRoot -Filter RELEASE.json -File -Recurse | Select-Object -First 1
    if ($null -eq $releaseMetadata) { throw 'The verified release archive does not contain RELEASE.json.' }
    $release = Get-Content -Raw -LiteralPath $releaseMetadata.FullName | ConvertFrom-Json
    if ($release.product -ne 'FORGE Workbench' -or $release.version -ne $ReleaseVersion -or $release.platform -ne 'windows-x64') {
        throw 'The verified release metadata does not match the requested Windows candidate.'
    }
    $releaseRoot = Split-Path -Parent $releaseMetadata.FullName

    $env:Path = "$NodeRoot;$postgresBin;$env:WINDIR\System32;$env:WINDIR"
    $env:APPDATA = Join-Path $profileRoot 'Roaming'
    $env:LOCALAPPDATA = Join-Path $profileRoot 'Local'
    New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null
    & (Join-Path $postgresBin 'initdb.exe') -D $dataRoot -U postgres --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale
    if ($LASTEXITCODE -ne 0) { throw 'Fresh PostgreSQL initialization failed.' }
    & $pgCtl -D $dataRoot -l (Join-Path $labRoot 'postgresql.log') -o "-p $DatabasePort -h 127.0.0.1" start
    if ($LASTEXITCODE -ne 0) { throw 'Fresh PostgreSQL startup failed.' }
    $postgresStarted = $true

    $adminPlain = New-RandomPassword
    $runtimePlain = New-RandomPassword
    $adminSecure = ConvertTo-SecureString $adminPlain -AsPlainText -Force
    $runtimeSecure = ConvertTo-SecureString $runtimePlain -AsPlainText -Force
    & (Join-Path $RepositoryRoot 'scripts\install-forge-windows.ps1') `
        -DatabasePort $DatabasePort -DatabaseName forge_lab -ConfigRoot $configRoot -WorkbenchPort $WorkbenchPort `
        -AdminPassword $adminSecure -RuntimePassword $runtimeSecure -SkipBuild -SkipWorkbench
    $bootstrap = Get-Content -Raw -LiteralPath (Join-Path $configRoot 'bootstrap-status.json') | ConvertFrom-Json
    if ($bootstrap.status -ne 'PASS') { throw 'Database bootstrap did not publish a PASS state.' }

    & (Join-Path $releaseRoot 'Install-FORGE-Workbench.ps1') `
        -InstallRoot $installRoot -ConfigRoot $configRoot -DatabasePort $DatabasePort -DatabaseName forge_lab `
        -DatabaseUser forge_runtime -CredentialFile forge-runtime.dpapi -WorkbenchPort $WorkbenchPort `
        -DatabasePassword $runtimeSecure -NoShortcuts -NoLaunch
    $installedRelease = Get-Content -Raw -LiteralPath (Join-Path $installRoot 'RELEASE.json') | ConvertFrom-Json
    if ($installedRelease.version -ne $ReleaseVersion) { throw 'Installed Workbench version does not match the public release.' }

    $workbenchProcess = Start-Process -FilePath (Join-Path $installRoot 'FORGE-Workbench.exe') -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 500
        try { $bootstrapResponse = Invoke-RestMethod -Uri "http://127.0.0.1:$WorkbenchPort/api/bootstrap" -TimeoutSec 2 } catch { $bootstrapResponse = $null }
    } while (-not $bootstrapResponse -and (Get-Date) -lt $deadline)
    if (-not $bootstrapResponse.token) { throw 'Installed Workbench did not start on loopback.' }
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$WorkbenchPort/api/status" -Headers @{ 'x-forge-token' = $bootstrapResponse.token } -TimeoutSec 10
    if ($status.result.schemaVersion -ne '0.1.3' -or $status.result.vectorVersion -notmatch '^0\.8\.') { throw 'Workbench reported an incompatible fresh database.' }

    Write-Host ''
    Write-Host "FORGE Workbench $ReleaseVersion local test lab is READY." -ForegroundColor Green
    Write-Host "URL: http://127.0.0.1:$WorkbenchPort"
    Write-Host "Fresh PostgreSQL: 127.0.0.1:$DatabasePort/forge_lab"
    Write-Host 'Your installed FORGE configuration and database are untouched.'
    Write-Host 'Keep this window open while testing.' -ForegroundColor Yellow
    $env:Path = $previousPath
    $env:APPDATA = $previousAppData
    $env:LOCALAPPDATA = $previousLocalAppData
    Start-Process "http://127.0.0.1:$WorkbenchPort" | Out-Null
    Read-Host 'Press ENTER here to stop and erase the lab' | Out-Null
} finally {
    if ($workbenchProcess) { Stop-Process -Id $workbenchProcess.Id -Force -ErrorAction SilentlyContinue }
    if ($postgresStarted) { & $pgCtl -D $dataRoot stop -m fast 2>$null | Out-Null }
    $env:Path = $previousPath
    $env:APPDATA = $previousAppData
    $env:LOCALAPPDATA = $previousLocalAppData
    $adminPlain = $null
    $runtimePlain = $null
    $adminSecure = $null
    $runtimeSecure = $null
    if (-not $KeepLab -and (Test-Path -LiteralPath $labRoot)) {
        $resolvedLab = [IO.Path]::GetFullPath($labRoot)
        $safePrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'FORGE-Workbench-Local-Lab-'
        if (-not $resolvedLab.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove an unexpected lab path.' }
        Remove-Item -LiteralPath $resolvedLab -Recurse -Force
    }
}
