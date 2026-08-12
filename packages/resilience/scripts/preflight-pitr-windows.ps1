[CmdletBinding()]
param(
    [string]$PostgresService = 'postgresql-x64-18',
    [string]$ArchiveDirectory = 'E:\FORGE PITR\wal',
    [ValidateRange(1,1024)][int]$MinimumFreeGiB = 20,
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$StatusPath = (Join-Path (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE') 'pitr-preflight.json')
)

$ErrorActionPreference = 'Stop'
$checks = [Collections.Generic.List[object]]::new()

function Add-Check([string]$Name, [string]$Status, [string]$Detail) {
    $checks.Add([ordered]@{ name = $Name; status = $Status; detail = $Detail })
}

function Convert-PostgresSize([string]$Value) {
    if ($Value -notmatch '^(?<amount>[0-9]+)(?<unit>B|kB|MB|GB)$') { throw "Unsupported PostgreSQL size: $Value" }
    $amount = [int64]$Matches.amount
    switch ($Matches.unit) {
        'B' { return $amount }
        'kB' { return $amount * 1KB }
        'MB' { return $amount * 1MB }
        'GB' { return $amount * 1GB }
    }
}

$service = Get-CimInstance Win32_Service -Filter "Name='$PostgresService'"
if (-not $service) { throw "PostgreSQL service was not found: $PostgresService" }
if ($service.State -eq 'Running') { Add-Check 'postgres-service' 'PASS' 'Service is running.' }
else { Add-Check 'postgres-service' 'FAIL' "Service state is $($service.State)." }

$executableMatch = [regex]::Match([string]$service.PathName, '^"([^"]+)"')
$dataMatch = [regex]::Match([string]$service.PathName, '(?:^|\s)-D\s+"([^"]+)"')
if (-not $executableMatch.Success -or -not $dataMatch.Success) {
    throw 'Could not safely parse PostgreSQL executable and data directory from the service command.'
}
$pgCtlPath = $executableMatch.Groups[1].Value
$dataDirectory = [IO.Path]::GetFullPath($dataMatch.Groups[1].Value)
$archivePath = [IO.Path]::GetFullPath($ArchiveDirectory)

$runtimePath = Join-Path $ConfigRoot 'resilience-runtime.json'
$databaseSecretPath = Join-Path $ConfigRoot 'resilience-database.dpapi'
$runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
$psqlPath = Join-Path ([string]$runtime.postgresBin) 'psql.exe'
if (-not (Test-Path -LiteralPath $psqlPath -PathType Leaf)) { throw "psql.exe was not found: $psqlPath" }
$protectedPassword = $null
$plainPassword = $null
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $protectedPassword = [Convert]::FromBase64String((Get-Content -LiteralPath $databaseSecretPath -Raw).Trim())
    $plainPassword = [Security.Cryptography.ProtectedData]::Unprotect($protectedPassword,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $env:PGPASSWORD = [Text.Encoding]::UTF8.GetString($plainPassword)
    $settingsOutput = & $psqlPath --host ([string]$runtime.database.host) --port ([string]$runtime.database.port) `
        --username ([string]$runtime.database.user) --dbname ([string]$runtime.database.name) `
        --no-psqlrc --tuples-only --no-align --field-separator '|' --set ON_ERROR_STOP=1 `
        --command "SELECT current_setting('wal_level'), current_setting('full_page_writes'), current_setting('archive_mode'), current_setting('archive_timeout'), current_setting('wal_segment_size');"
    if ($LASTEXITCODE -ne 0) { throw "Could not read safe PostgreSQL settings with the recovery role (exit $LASTEXITCODE)." }
}
finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    if ($plainPassword) { [Array]::Clear($plainPassword,0,$plainPassword.Length) }
    if ($protectedPassword) { [Array]::Clear($protectedPassword,0,$protectedPassword.Length) }
}
$settings = ([string]$settingsOutput).Trim().Split('|')
if ($settings.Count -ne 5) { throw 'PostgreSQL returned an unexpected settings record.' }
$walLevel = $settings[0]
$fullPageWrites = $settings[1]
$archiveMode = $settings[2]
$archiveTimeout = $settings[3]
$segmentBytes = Convert-PostgresSize $settings[4]

if ($walLevel -in @('replica','logical')) { Add-Check 'wal-level' 'PASS' "wal_level=$walLevel" }
else { Add-Check 'wal-level' 'FAIL' "wal_level=$walLevel does not support PITR." }
if ($fullPageWrites -eq 'on') { Add-Check 'full-page-writes' 'PASS' 'full_page_writes=on' }
else { Add-Check 'full-page-writes' 'FAIL' 'full_page_writes must be on.' }
Add-Check 'archive-current-state' 'INFO' "archive_mode=$archiveMode; archive_timeout=$archiveTimeout"

$dataRoot = [IO.Path]::GetPathRoot($dataDirectory).TrimEnd('\')
$archiveRoot = [IO.Path]::GetPathRoot($archivePath).TrimEnd('\')
if ($dataRoot -ne $archiveRoot) { Add-Check 'independent-volume' 'PASS' "Data=$dataRoot; archive=$archiveRoot" }
else { Add-Check 'independent-volume' 'FAIL' 'Archive and PostgreSQL data are on the same volume.' }

$archiveDrive = $archiveRoot.TrimEnd(':')
$volume = Get-Volume -DriveLetter $archiveDrive -ErrorAction Stop
$minimumBytes = [int64]$MinimumFreeGiB * 1GB
if ($volume.HealthStatus -eq 'Healthy' -and $volume.SizeRemaining -ge $minimumBytes) {
    Add-Check 'archive-capacity' 'PASS' ("{0:N1} GiB free; minimum {1} GiB." -f ($volume.SizeRemaining / 1GB),$MinimumFreeGiB)
} else {
    Add-Check 'archive-capacity' 'FAIL' ("Health={0}; free={1:N1} GiB." -f $volume.HealthStatus,($volume.SizeRemaining / 1GB))
}

foreach ($scriptName in @('archive-wal.ps1','restore-wal.ps1')) {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot $scriptName) -PathType Leaf) {
        Add-Check $scriptName 'PASS' 'Script exists.'
    } else {
        Add-Check $scriptName 'FAIL' 'Script is missing.'
    }
}

foreach ($mountPoint in @($dataRoot,$archiveRoot)) {
    try {
        $bitLocker = Get-BitLockerVolume -MountPoint $mountPoint -ErrorAction Stop
        if ($bitLocker.ProtectionStatus -eq 'On') {
            Add-Check "bitlocker-$mountPoint" 'PASS' 'BitLocker protection is on.'
        } else {
            Add-Check "bitlocker-$mountPoint" 'FAIL' "ProtectionStatus=$($bitLocker.ProtectionStatus)"
        }
    }
    catch {
        Add-Check "bitlocker-$mountPoint" 'BLOCKED' 'Run preflight elevated to verify BitLocker.'
    }
}

$retentionDays = 14
$projectedWalBytes = $segmentBytes * 24 * $retentionDays
$hasFailure = @($checks | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0
$hasBlocked = @($checks | Where-Object { $_.status -eq 'BLOCKED' }).Count -gt 0
$status = 'READY'
if ($hasFailure) { $status = 'FAIL' }
elseif ($hasBlocked) { $status = 'BLOCKED' }

$result = [ordered]@{
    status = $status
    activationPerformed = $false
    service = $PostgresService
    serviceIdentity = [string]$service.StartName
    dataDirectory = $dataDirectory
    archiveDirectory = $archivePath
    target = [ordered]@{
        rpoMinutes = 60
        localRetentionDays = $retentionDays
        archiveTimeout = '1h'
        projectedForcedWalGiB = [Math]::Round($projectedWalBytes / 1GB,2)
        minimumFreeGiB = $MinimumFreeGiB
    }
    checks = $checks
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
}

$statusDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($StatusPath))
New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
$temporaryStatus = "$StatusPath.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporaryStatus -Encoding utf8
    Move-Item -LiteralPath $temporaryStatus -Destination $StatusPath -Force
}
finally {
    Remove-Item -LiteralPath $temporaryStatus -Force -ErrorAction SilentlyContinue
}

$result | ConvertTo-Json -Depth 6
if ($status -ne 'READY') { exit 2 }
