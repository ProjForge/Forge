[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\FORGE Workbench'),
    [string]$ConfigRoot = (Join-Path $env:APPDATA 'FORGE'),
    [string]$DatabaseHost = '127.0.0.1',
    [ValidateRange(1, 65535)][int]$DatabasePort = 5432,
    [string]$DatabaseName = 'forge',
    [string]$DatabaseUser = 'forge_runtime',
    [ValidatePattern('^[^\\/:*?"<>|]+$')][string]$CredentialFile = 'workbench.dpapi',
    [ValidateRange(1, 65535)][int]$WorkbenchPort = 7334,
    [Security.SecureString]$DatabasePassword,
    [switch]$Reconfigure,
    [switch]$AllowDowngrade,
    [switch]$SkipPackageVerification,
    [switch]$NoShortcuts,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-VersionKey([string]$Value) {
    if ($Value -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$') { throw "Unsupported FORGE version: $Value" }
    $revision = if ([string]::IsNullOrWhiteSpace($Matches[4])) { 65535 } else { [int]$Matches[4] }
    return [version]('{0}.{1}.{2}.{3}' -f $Matches[1], $Matches[2], $Matches[3], $revision)
}

function Test-Distribution([string]$Root) {
    $manifestPath = Join-Path $Root 'SHA256SUMS.txt'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The package checksum manifest is missing.' }
    $covered = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $rootPrefix = $Root + [IO.Path]::DirectorySeparatorChar
    if (@(Get-ChildItem -LiteralPath $Root -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) {
        throw 'The package contains a reparse point.'
    }
    foreach ($line in Get-Content -LiteralPath $manifestPath) {
        if ($line -notmatch '^([0-9A-Fa-f]{64})  (.+)$') { throw 'The package checksum manifest is invalid.' }
        $expectedHash = $Matches[1].ToUpperInvariant()
        $manifestName = $Matches[2]
        $relative = $manifestName.Replace('/', [IO.Path]::DirectorySeparatorChar)
        if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') { throw 'The package checksum manifest contains an unsafe path.' }
        $target = [IO.Path]::GetFullPath((Join-Path $Root $relative))
        if (-not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'The package checksum manifest references a missing file.' }
        if ((Get-Sha256 $target) -ne $expectedHash) { throw "Package checksum mismatch: $manifestName" }
        if (-not $covered.Add($relative)) { throw 'The package checksum manifest contains a duplicate path.' }
    }
    $packaged = @(Get-ChildItem -LiteralPath $Root -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS.txt' })
    if ($packaged.Count -ne $covered.Count) { throw 'The package checksum manifest does not cover every file exactly once.' }
}

function Write-Dpapi([Security.SecureString]$Secret, [string]$Path) {
    Add-Type -AssemblyName System.Security
    $bstr = [IntPtr]::Zero
    $plainBytes = $null
    $protectedBytes = $null
    try {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
        $plainBytes = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllText($Path, [Convert]::ToBase64String($protectedBytes), [Text.Encoding]::ASCII)
    } finally {
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
        if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    }
}

function Assert-SafeManagedPath([string]$Path, [string]$Label) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $root = [IO.Path]::GetPathRoot($full).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $blocked = @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
        [IO.Path]::GetFullPath($_).TrimEnd([IO.Path]::DirectorySeparatorChar)
    }
    if ($full -eq $root -or $blocked -contains $full -or [string]::IsNullOrWhiteSpace((Split-Path -Leaf $full))) { throw "$Label is too broad for a managed FORGE path." }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label cannot be a reparse point." }
    }
}

$sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSCommandPath))
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$ConfigRoot = [IO.Path]::GetFullPath($ConfigRoot)
Assert-SafeManagedPath $InstallRoot 'InstallRoot'
Assert-SafeManagedPath $ConfigRoot 'ConfigRoot'
if ($InstallRoot -eq $sourceRoot -or $InstallRoot.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'InstallRoot must be outside the extracted release package.' }
foreach ($requiredName in @('FORGE-Workbench.exe', 'Launch-FORGE-Workbench.vbs', 'Uninstall-FORGE-Workbench.ps1', 'Export-FORGE-Diagnostics.ps1', 'RELEASE.json', 'public')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $requiredName))) { throw "Missing distribution path: $requiredName" }
}
if (-not $SkipPackageVerification) { Test-Distribution $sourceRoot }

$release = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'RELEASE.json') | ConvertFrom-Json
if ($release.product -ne 'FORGE Workbench' -or [string]::IsNullOrWhiteSpace([string]$release.version)) { throw 'Release metadata is invalid.' }
$incomingVersion = [string]$release.version
$existingReleasePath = Join-Path $InstallRoot 'RELEASE.json'
$isUpgrade = Test-Path -LiteralPath $InstallRoot -PathType Container
if ($isUpgrade -and (Test-Path -LiteralPath $existingReleasePath -PathType Leaf)) {
    try { $installedVersion = [string](Get-Content -Raw -LiteralPath $existingReleasePath | ConvertFrom-Json).version }
    catch { throw 'Installed FORGE release metadata is invalid; refusing an unsafe update.' }
    if (-not $AllowDowngrade -and (Get-VersionKey $incomingVersion) -lt (Get-VersionKey $installedVersion)) { throw "Refusing to downgrade FORGE Workbench from $installedVersion to $incomingVersion without -AllowDowngrade." }
}

$configPath = Join-Path $ConfigRoot 'workbench.json'
$existingConfig = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    try { $existingConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json }
    catch { throw 'Existing FORGE shared configuration is invalid; refusing to overwrite it.' }
}
$existingDatabase = if ($null -ne $existingConfig) { $existingConfig.database } else { $null }
$existingWorkbench = if ($null -ne $existingConfig) { $existingConfig.workbench } else { $null }
if ($isUpgrade -and $Reconfigure -and $null -ne $existingDatabase) {
    if (-not $PSBoundParameters.ContainsKey('DatabaseHost')) { $DatabaseHost = [string]$existingDatabase.host }
    if (-not $PSBoundParameters.ContainsKey('DatabasePort')) { $DatabasePort = [int]$existingDatabase.port }
    if (-not $PSBoundParameters.ContainsKey('DatabaseName')) { $DatabaseName = [string]$existingDatabase.name }
    if (-not $PSBoundParameters.ContainsKey('DatabaseUser')) { $DatabaseUser = [string]$existingDatabase.user }
    if (-not $PSBoundParameters.ContainsKey('CredentialFile')) { $CredentialFile = [string]$existingDatabase.credentialFile }
    if (-not $PSBoundParameters.ContainsKey('WorkbenchPort') -and $null -ne $existingWorkbench) { $WorkbenchPort = [int]$existingWorkbench.port }
}
$connectionArguments = @('DatabaseHost','DatabasePort','DatabaseName','DatabaseUser','CredentialFile','WorkbenchPort','DatabasePassword')
$connectionChangeRequested = @($connectionArguments | Where-Object { $PSBoundParameters.ContainsKey($_) }).Count -gt 0
if ($isUpgrade -and -not $Reconfigure -and $connectionChangeRequested) { throw 'Updating connection settings requires -Reconfigure. A normal update preserves configuration and DPAPI credentials.' }

$writeConfiguration = -not $isUpgrade -or $Reconfigure -or $null -eq $existingConfig
$configurationTemporary = $null
$credentialTemporary = $null
$effectiveCredentialFile = $CredentialFile
if ($writeConfiguration) {
    if ([string]::IsNullOrWhiteSpace($DatabaseHost) -or [string]::IsNullOrWhiteSpace($DatabaseName) -or [string]::IsNullOrWhiteSpace($DatabaseUser)) { throw 'Database host, name and user must not be blank.' }
    if ($null -eq $DatabasePassword) { $DatabasePassword = Read-Host 'PostgreSQL password for the FORGE runtime user' -AsSecureString }
    New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null
    $token = [Guid]::NewGuid().ToString('N')
    $configurationTemporary = Join-Path $ConfigRoot ("workbench.$token.tmp")
    $credentialTemporary = Join-Path $ConfigRoot ("credential.$token.tmp")
    $config = [ordered]@{
        version = 1
        database = [ordered]@{ host=$DatabaseHost; port=$DatabasePort; name=$DatabaseName; user=$DatabaseUser; credentialFile=$CredentialFile }
        workbench = [ordered]@{ port=$WorkbenchPort }
    }
    if ($null -ne $existingConfig -and $null -ne $existingConfig.embedding) { $config['embedding'] = $existingConfig.embedding }
    [IO.File]::WriteAllText($configurationTemporary, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Write-Dpapi $DatabasePassword $credentialTemporary
} elseif ($null -ne $existingConfig) {
    $effectiveCredentialFile = [string]$existingConfig.database.credentialFile
    if ([string]::IsNullOrWhiteSpace($effectiveCredentialFile) -or -not (Test-Path -LiteralPath (Join-Path $ConfigRoot $effectiveCredentialFile) -PathType Leaf)) { throw 'The preserved FORGE DPAPI credential is missing.' }
}

$parent = Split-Path -Parent $InstallRoot
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$transaction = [Guid]::NewGuid().ToString('N')
$stagedRoot = Join-Path $parent ('.forge-workbench-stage-' + $transaction)
$backupRoot = Join-Path $parent ('.forge-workbench-backup-' + $transaction)
$configBackup = Join-Path $ConfigRoot ('.workbench-config-backup-' + $transaction)
$credentialPath = Join-Path $ConfigRoot $effectiveCredentialFile
$credentialBackup = Join-Path $ConfigRoot ('.workbench-credential-backup-' + $transaction)
$applicationMoved = $false
$configurationMoved = $false
$credentialMoved = $false
$applicationPublished = $false
$configurationPublished = $false
$credentialPublished = $false
try {
    New-Item -ItemType Directory -Path $stagedRoot | Out-Null
    Get-ChildItem -LiteralPath $sourceRoot -Force | Copy-Item -Destination $stagedRoot -Recurse -Force
    $installPrefix = $InstallRoot + [IO.Path]::DirectorySeparatorChar
    Get-Process -Name 'FORGE-Workbench' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force
    if (Test-Path -LiteralPath $InstallRoot) { Move-Item -LiteralPath $InstallRoot -Destination $backupRoot; $applicationMoved = $true }
    Move-Item -LiteralPath $stagedRoot -Destination $InstallRoot
    $applicationPublished = $true
    if ($writeConfiguration) {
        if (Test-Path -LiteralPath $configPath) { Move-Item -LiteralPath $configPath -Destination $configBackup; $configurationMoved = $true }
        if (Test-Path -LiteralPath $credentialPath) { Move-Item -LiteralPath $credentialPath -Destination $credentialBackup; $credentialMoved = $true }
        Move-Item -LiteralPath $configurationTemporary -Destination $configPath
        $configurationPublished = $true
        Move-Item -LiteralPath $credentialTemporary -Destination $credentialPath
        $credentialPublished = $true
    }
    $installedConfig = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $effectivePort = [int]$installedConfig.workbench.port
    "http://127.0.0.1:$effectivePort" | Set-Content -LiteralPath (Join-Path $InstallRoot 'workbench.url') -Encoding ascii -NoNewline
    if (-not $NoShortcuts) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'FORGE Workbench.lnk'))
        $shortcut.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe')
        $shortcut.Arguments = '//nologo "' + (Join-Path $InstallRoot 'Launch-FORGE-Workbench.vbs') + '"'
        $shortcut.WorkingDirectory = $InstallRoot
        $shortcut.Description = 'Open FORGE Workbench'
        $shortcut.Save()
    }
    Remove-Item -LiteralPath $backupRoot, $configBackup, $credentialBackup -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    if ($applicationPublished) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if ($applicationMoved -and (Test-Path -LiteralPath $backupRoot)) { Move-Item -LiteralPath $backupRoot -Destination $InstallRoot }
    if ($writeConfiguration) {
        if ($configurationPublished) { Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue }
        if ($credentialPublished) { Remove-Item -LiteralPath $credentialPath -Force -ErrorAction SilentlyContinue }
        if ($configurationMoved -and (Test-Path -LiteralPath $configBackup)) { Move-Item -LiteralPath $configBackup -Destination $configPath }
        if ($credentialMoved -and (Test-Path -LiteralPath $credentialBackup)) { Move-Item -LiteralPath $credentialBackup -Destination $credentialPath }
    }
    throw
} finally {
    @($stagedRoot, $configurationTemporary, $credentialTemporary) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
        Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction SilentlyContinue
    }
    $DatabasePassword = $null
}

$operation = if ($isUpgrade) { 'updated' } else { 'installed' }
Write-Output "FORGE Workbench $incomingVersion $operation in $InstallRoot"
if ($isUpgrade -and -not $Reconfigure) { Write-Output 'Existing configuration and CurrentUser DPAPI credential were preserved.' }
else { Write-Output "Configuration stored in $ConfigRoot (password protected by CurrentUser DPAPI)" }
if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList '//nologo', ('"' + (Join-Path $InstallRoot 'Launch-FORGE-Workbench.vbs') + '"') -WindowStyle Hidden }
