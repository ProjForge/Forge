[CmdletBinding()]
param(
    [string]$Root = 'E:\FORGE PITR',
    [ValidateRange(1,1024)][int]$MinimumFreeGiB = 20
)

$ErrorActionPreference = 'Stop'
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$networkServiceSid = 'S-1-5-20'
$administratorsSid = 'S-1-5-32-544'
$systemSid = 'S-1-5-18'
$rootPath = [IO.Path]::GetFullPath($Root)
$rootDrive = [IO.Path]::GetPathRoot($rootPath).TrimEnd('\').TrimEnd(':')

$volume = Get-Volume -DriveLetter $rootDrive
$bitLocker = Get-BitLockerVolume -MountPoint "${rootDrive}:"
if ($volume.HealthStatus -ne 'Healthy' -or $volume.SizeRemaining -lt ([int64]$MinimumFreeGiB * 1GB)) {
    throw "PITR volume does not meet the health/capacity gate: ${rootDrive}:"
}
if ($bitLocker.ProtectionStatus -ne 'On' -or $bitLocker.LockStatus -ne 'Unlocked') {
    throw "PITR volume must be BitLocker-protected and unlocked: ${rootDrive}:"
}

New-Item -ItemType Directory -Force -Path $rootPath | Out-Null
& icacls.exe $rootPath '/inheritance:r' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not disable inherited ACLs on the PITR root.' }
& icacls.exe $rootPath '/grant:r' "*${currentUserSid}:(OI)(CI)F" "*${administratorsSid}:(OI)(CI)F" "*${systemSid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set PITR root recovery ACLs.' }

foreach ($name in @('wal','staging','encrypted','receipts','status')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $rootPath $name) | Out-Null
}
$wal = Join-Path $rootPath 'wal'
& icacls.exe $wal '/grant:r' "*${currentUserSid}:(OI)(CI)F" "*${administratorsSid}:(OI)(CI)F" "*${systemSid}:(OI)(CI)F" "*${networkServiceSid}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not grant NetworkService WAL access.' }

[ordered]@{
    status = 'PASS'
    root = $rootPath
    directories = @('wal','staging','encrypted','receipts','status')
    networkServiceScope = 'wal-only'
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 4
