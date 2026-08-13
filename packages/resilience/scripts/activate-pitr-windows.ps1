[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [string]$PostgresService = 'postgresql-x64-18',
    [string]$ArchiveRuntimeRoot = 'C:\ProgramData\FORGE\resilience',
    [Security.SecureString]$AdminPassword,
    [switch]$Activate,
    [switch]$Rollback,
    [switch]$PlanOnly,
    [string]$PlanDataDirectory
)

$ErrorActionPreference = 'Stop'
$statusPath = Join-Path $ConfigRoot 'pitr-activation-status.json'
$recordPath = Join-Path $ConfigRoot 'pitr-activation-record.json'
$runtimePath = Join-Path $ConfigRoot 'pitr-runtime.json'
$root = [IO.Path]::GetFullPath($PitrRoot)
$walRoot = Join-Path $root 'wal'
$archiveSourceScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'archive-wal.ps1'))
$archiveRuntimeRootPath = [IO.Path]::GetFullPath($ArchiveRuntimeRoot)
$archiveScript = Join-Path $archiveRuntimeRootPath 'archive-wal.ps1'
$uploaderScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1'))
$monitorScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-pitr-monitor-windows.ps1'))
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$archiveCommand = "`"$powerShell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$archiveScript`" -Source `"%p`" -FileName `"%f`" -ArchiveDirectory `"$walRoot`""
$adminPointer = [IntPtr]::Zero
$adminPlain = $null
$configChanged = $false
$backupDirectory = $null
$record = $null

function Write-AtomicJson([string]$Path,[object]$Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try { $Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding utf8; Move-Item -LiteralPath $temporary -Destination $Path -Force }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
function Require-Elevation {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'PITR activation and rollback require an elevated PowerShell session.' }
}
function Get-ServiceLayout {
    if ($PlanDataDirectory) {
        if (-not $PlanOnly) { throw 'PlanDataDirectory is accepted only with PlanOnly.' }
        return [ordered]@{dataDirectory=[IO.Path]::GetFullPath($PlanDataDirectory);state='PlanOverride'}
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='$PostgresService'"
    if (-not $service) { throw "PostgreSQL service was not found: $PostgresService" }
    $match = [regex]::Match([string]$service.PathName,'(?:^|\s)-D\s+"([^"]+)"')
    if (-not $match.Success) { throw 'Could not safely parse the PostgreSQL data directory.' }
    return [ordered]@{dataDirectory=[IO.Path]::GetFullPath($match.Groups[1].Value);state=[string]$service.State}
}
function Set-AdminPassword {
    if (-not $AdminPassword) { $script:AdminPassword = Read-Host "Password for PostgreSQL administrator 'postgres'" -AsSecureString }
    $script:adminPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($AdminPassword)
    $script:adminPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($script:adminPointer)
    $env:PGPASSWORD = $script:adminPlain
}
function Invoke-AdminSql([string]$Sql,[switch]$Scalar,[string]$Database='postgres') {
    $physical = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    $psql = Join-Path ([string]$physical.postgresBin) 'psql.exe'
    $arguments = @('-X','-w','-v','ON_ERROR_STOP=1','-h',[string]$physical.replication.host,'-p',[string]$physical.replication.port,'-U','postgres','-d',$Database)
    if ($Scalar) { $arguments += @('-A','-t') }
    $arguments += @('-f','-')
    $output = $Sql | & $psql @arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Administrative PostgreSQL command failed: $($output -join ' ')" }
    if ($Scalar) { return (($output | Out-String).Trim()) }
    return $output
}
function Restore-Configuration([object]$ActivationRecord) {
    $backupRoot = [IO.Path]::GetFullPath([string]$ActivationRecord.backupDirectory)
    $expectedRoot = [IO.Path]::GetFullPath($ConfigRoot).TrimEnd('\') + '\pitr-config-backup-'
    if (-not $backupRoot.StartsWith($expectedRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Activation backup path is outside the trusted configuration root.' }
    $dataDirectory = [IO.Path]::GetFullPath([string]$ActivationRecord.dataDirectory)
    $service = Get-Service -Name $PostgresService -ErrorAction Stop
    if ($service.Status -ne 'Stopped') { Stop-Service -Name $PostgresService -Force -ErrorAction Stop; (Get-Service $PostgresService).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30)) }
    foreach ($file in @($ActivationRecord.files)) {
        $target = Join-Path $dataDirectory ([string]$file.name)
        if ([bool]$file.existed) {
            $backupFile = Join-Path $backupRoot ([string]$file.name)
            if ((Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$file.sha256) { throw "Configuration backup checksum failed: $($file.name)" }
            Copy-Item -LiteralPath $backupFile -Destination $target -Force
        }
        else { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
    }
    $runtimeBackup = Join-Path $backupRoot 'pitr-runtime.json'
    if ((Get-FileHash -LiteralPath $runtimeBackup -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$ActivationRecord.runtimeSha256) { throw 'PITR runtime backup checksum failed.' }
    Copy-Item -LiteralPath $runtimeBackup -Destination $runtimePath -Force
    Start-Service -Name $PostgresService -ErrorAction Stop
    (Get-Service $PostgresService).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
}

$layout = Get-ServiceLayout
$plan = [ordered]@{
    service=$PostgresService;dataDirectory=$layout.dataDirectory;archiveDirectory=$walRoot
    archiveMode='on';archiveTimeout='1h';archiveCommand=$archiveCommand
    steps=@('fresh elevated preflight','backup configuration with SHA-256','deploy NetworkService-readable archive script','ALTER SYSTEM','single service restart','verify FORGE','force WAL switch','authenticate AWS receipt','run fail-closed monitor')
    rollback='restore exact configuration and pitr-runtime backup, then restart service'
}
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 6; exit 0 }
if ($Activate -eq $Rollback) { throw 'Specify exactly one of Activate or Rollback.' }
Require-Elevation

if ($Rollback) {
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    Restore-Configuration $record
    Write-AtomicJson $statusPath ([ordered]@{status='ROLLED_BACK';rolledBackAt=[datetime]::UtcNow.ToString('o');service=$PostgresService;backupDirectory=$record.backupDirectory})
    exit 0
}

try {
    $physical = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    if ([bool]$physical.enabled) { throw 'PITR is already enabled.' }
    if ([string]$layout.state -ne 'Running') { throw "PostgreSQL service state is $($layout.state)." }
    & (Join-Path $PSScriptRoot 'preflight-pitr-windows.ps1') -PostgresService $PostgresService -ArchiveDirectory $walRoot -ConfigRoot $ConfigRoot -StatusPath (Join-Path $ConfigRoot 'pitr-preflight.json') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fresh elevated PITR preflight did not return READY.' }
    foreach ($taskName in @('FORGE PITR WAL Uploader','FORGE PITR Daily Base Backup','FORGE PITR Monitor')) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        if ($task.Principal.RunLevel -ne 'Limited') { throw "PITR task is not limited: $taskName" }
    }
    $baseReceipt = Get-ChildItem -LiteralPath (Join-Path $root 'receipts') -Filter 'base-*.receipt.json' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $baseReceipt) { throw 'No authenticated base-backup receipt exists.' }
    $base = Get-Content -LiteralPath $baseReceipt.FullName -Raw | ConvertFrom-Json
    if (([datetime]::UtcNow - ([datetime]$base.authenticatedAt).ToUniversalTime()).TotalHours -gt 26) { throw 'Newest authenticated base backup is older than 26 hours.' }

    $stamp = [datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $backupDirectory = Join-Path ([IO.Path]::GetFullPath($ConfigRoot)) "pitr-config-backup-$stamp"
    New-Item -ItemType Directory -Path $backupDirectory -ErrorAction Stop | Out-Null
    $files = foreach ($name in @('postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf')) {
        $source = Join-Path $layout.dataDirectory $name
        $exists = Test-Path -LiteralPath $source -PathType Leaf
        if ($exists) { Copy-Item -LiteralPath $source -Destination (Join-Path $backupDirectory $name); $sha=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() } else { $sha=$null }
        [ordered]@{name=$name;existed=$exists;sha256=$sha}
    }
    Copy-Item -LiteralPath $runtimePath -Destination (Join-Path $backupDirectory 'pitr-runtime.json')
    $runtimeSha = (Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $record = [ordered]@{status='PREPARED';preparedAt=[datetime]::UtcNow.ToString('o');service=$PostgresService;dataDirectory=$layout.dataDirectory;backupDirectory=$backupDirectory;runtimeSha256=$runtimeSha;files=@($files);plan=$plan}
    Write-AtomicJson $recordPath $record
    Write-AtomicJson (Join-Path $backupDirectory 'manifest.json') $record

    New-Item -ItemType Directory -Force -Path $archiveRuntimeRootPath | Out-Null
    Copy-Item -LiteralPath $archiveSourceScript -Destination $archiveScript -Force
    & icacls.exe $archiveRuntimeRootPath '/inheritance:r' | Out-Null
    & icacls.exe $archiveRuntimeRootPath '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-20:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not establish the archive runtime ACL.' }
    & icacls.exe $archiveScript '/verify' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Archive runtime ACL verification failed.' }

    Set-AdminPassword
    $escapedCommand = $archiveCommand.Replace("'","''")
    Invoke-AdminSql "ALTER SYSTEM SET archive_mode='on';" | Out-Null
    $configChanged = $true
    Invoke-AdminSql "ALTER SYSTEM SET archive_timeout='1h';" | Out-Null
    Invoke-AdminSql "ALTER SYSTEM SET archive_command='$escapedCommand';" | Out-Null
    Restart-Service -Name $PostgresService -Force -ErrorAction Stop
    (Get-Service $PostgresService).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    $settings = Invoke-AdminSql "SELECT current_setting('archive_mode') || '|' || current_setting('archive_timeout') || '|' || current_setting('archive_command');" -Scalar
    if (-not $settings.StartsWith('on|1h|',[StringComparison]::Ordinal) -or -not $settings.Contains($archiveScript)) { throw "Effective archive settings are incorrect: $settings" }
    $forgeRows = Invoke-AdminSql 'SELECT count(*) FROM forge.projects;' -Scalar -Database 'forge_test'
    if ([int64]$forgeRows -lt 1) { throw 'Post-restart FORGE project validation returned no rows.' }

    $physical.enabled = $true
    $physical | Add-Member -NotePropertyName activatedAt -NotePropertyValue ([datetime]::UtcNow.ToString('o')) -Force
    $physical | Add-Member -NotePropertyName activationLsn -NotePropertyValue (Invoke-AdminSql 'SELECT pg_current_wal_lsn()::text;' -Scalar) -Force
    Write-AtomicJson $runtimePath $physical
    $wal = Invoke-AdminSql 'SELECT pg_walfile_name(pg_switch_wal());' -Scalar
    if ($wal -notmatch '^[0-9A-F]{24}$') { throw "PostgreSQL returned an invalid WAL file name: $wal" }
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path -LiteralPath (Join-Path $walRoot $wal)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Path -LiteralPath (Join-Path $walRoot $wal))) { throw "Forced WAL segment was not archived locally: $wal" }
    & $uploaderScript -ConfigRoot $ConfigRoot -PitrRoot $root | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $root "receipts\wal-$wal.receipt.json"))) { throw "Forced WAL segment was not remotely authenticated: $wal" }
    & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $monitorScript -ConfigRoot $ConfigRoot -PitrRoot $root | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Post-activation PITR monitor failed.' }
    $record['status']='ACTIVE';$record['activatedAt']=$physical.activatedAt;$record['forcedWal']=$wal
    Write-AtomicJson $recordPath $record
    Write-AtomicJson $statusPath ([ordered]@{status='PASS';activatedAt=$physical.activatedAt;forcedWal=$wal;backupDirectory=$backupDirectory;rollbackCommand="activate-pitr-windows.ps1 -Rollback"})
    [ordered]@{status='PASS';archiveMode='on';archiveTimeout='1h';forcedWal=$wal;receipt=(Join-Path $root "receipts\wal-$wal.receipt.json");backupDirectory=$backupDirectory} | ConvertTo-Json -Depth 5
}
catch {
    $failure = $_.Exception.Message
    if ($configChanged -and $record) {
        try { Restore-Configuration $record; Write-AtomicJson $statusPath ([ordered]@{status='ROLLED_BACK_AFTER_FAILURE';error=$failure;rolledBackAt=[datetime]::UtcNow.ToString('o')}) }
        catch { Write-AtomicJson $statusPath ([ordered]@{status='CRITICAL_ROLLBACK_FAILED';activationError=$failure;rollbackError=$_.Exception.Message;checkedAt=[datetime]::UtcNow.ToString('o')}) }
    } else { Write-AtomicJson $statusPath ([ordered]@{status='FAIL';error=$failure;checkedAt=[datetime]::UtcNow.ToString('o')}) }
    throw
}
finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    $adminPlain=$null
    if ($adminPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPointer) }
}
