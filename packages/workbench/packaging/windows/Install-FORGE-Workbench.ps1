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
    [switch]$ConnectionOnly,
    [switch]$AllowDowngrade,
    [switch]$SkipPackageVerification,
    [switch]$NoShortcuts,
    [switch]$NoLaunch,
    [string]$DistributionRoot = $PSScriptRoot,
    [string]$TrustedManifest,
    [switch]$Inspect,
    [switch]$CheckOnly
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
    $manifest = @(Get-Content -LiteralPath $manifestPath)
    if ($TrustedManifest) {
        $embedded = @($TrustedManifest.Trim() -split '\r?\n' | Sort-Object)
        $sidecar = @($manifest | Where-Object { $_ -notmatch '  FORGE-Setup\.exe$' } | Sort-Object)
        if ($embedded.Count -ne $sidecar.Count -or ($embedded -join "`n") -cne ($sidecar -join "`n")) {
            throw 'The distribution is different from the payload embedded in this FORGE Setup.'
        }
    }
    foreach ($line in $manifest) {
        if ($line -notmatch '^([0-9A-Fa-f]{64})  (.+)$') { throw 'The package checksum manifest is invalid.' }
        $expectedHash = $Matches[1].ToUpperInvariant()
        $manifestName = $Matches[2]
        $relative = $manifestName.Replace('/', [IO.Path]::DirectorySeparatorChar)
        if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or $relative -match '(^|[\\/])\.\.([\\/]|$)') { throw 'The package checksum manifest contains an unsafe path.' }
        $target = [IO.Path]::GetFullPath((Join-Path $Root $relative))
        if (-not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'The package checksum manifest references a missing file.' }
        if ((Get-Sha256 $target) -ne $expectedHash) { throw "Package checksum mismatch: $manifestName" }
        if (-not $covered.Add($target)) { throw 'The package checksum manifest contains a duplicate path.' }
    }
    $packaged = @(Get-ChildItem -LiteralPath $Root -File -Recurse | Where-Object { $_.FullName -ne $manifestPath })
    if ($packaged.Count -ne $covered.Count -or @($packaged | Where-Object { -not $covered.Contains($_.FullName) }).Count -ne 0) { throw 'The package checksum manifest does not cover every file exactly once.' }
}

function Write-Dpapi([Security.SecureString]$Secret, [string]$Path) {
    Add-Type -AssemblyName System.Security
    $plainBytes = $null
    $protectedBytes = $null
    try {
        $plainBytes = Get-SecretBytes $Secret
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllText($Path, [Convert]::ToBase64String($protectedBytes), [Text.Encoding]::ASCII)
    } finally {
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

function Assert-CredentialFile([string]$Name) {
    if ($Name -notmatch '^[^\\/:*?"<>|\x00-\x1f]+$' -or $Name -match '[. ]$' -or $Name -eq 'workbench.json' -or
        $Name -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'The FORGE credential must be a safe DPAPI file name.' }
}

function Get-SecretBytes([Security.SecureString]$Secret) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    $characters = [char[]]::new($Secret.Length)
    try {
        [Runtime.InteropServices.Marshal]::Copy($bstr, $characters, 0, $characters.Length)
        return ,([Text.Encoding]::UTF8.GetBytes($characters))
    } finally {
        [Array]::Clear($characters, 0, $characters.Length)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Invoke-DatabaseCheck([string]$Executable, [string[]]$Arguments, [Security.SecureString]$Secret) {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    # Windows argv quoting also handles a backslash immediately before a closing quote.
    $start.Arguments = '--check-database ' + (($Arguments | ForEach-Object {
        '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
    }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($start)
    $bytes = $null
    try {
        $null = $child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $null = $child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        if ($null -ne $Secret) {
            $bytes = Get-SecretBytes $Secret
            $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        }
        $child.StandardInput.Close()
        if (-not $child.WaitForExit(20000)) { throw 'PostgreSQL is unavailable or the connection check timed out.' }
        switch ($child.ExitCode) {
            0 { return }
            10 { throw 'PostgreSQL rejected the credentials or the connection authentication rule.' }
            11 { throw 'The FORGE database or required schema migrations are missing.' }
            12 { throw 'The database role lacks required FORGE runtime permissions.' }
            14 { throw 'The saved FORGE configuration or CurrentUser DPAPI credential is invalid.' }
            default { throw 'PostgreSQL is unavailable or the connection check failed.' }
        }
    } finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(2000) }
        $child.Dispose()
    }
}

function Test-PackageConnection([string]$Root, [string[]]$Arguments, [Security.SecureString]$Secret) {
    $executable = Join-Path $Root 'FORGE-Workbench.exe'
    if (-not $TrustedManifest) { Invoke-DatabaseCheck $executable $Arguments $Secret; return }
    $expected = @($TrustedManifest.Trim() -split '\r?\n' | Where-Object { $_ -match '^[A-F0-9]{64}  FORGE-Workbench\.exe$' })
    if ($expected.Count -ne 1) { throw 'FORGE Setup is missing its trusted Workbench checksum.' }
    $probeRoot = Join-Path $env:LOCALAPPDATA ('FORGE-Setup-' + [Guid]::NewGuid().ToString('N'))
    $probe = Join-Path $probeRoot 'FORGE-Workbench.exe'
    try {
        New-Item -ItemType Directory -Path $probeRoot | Out-Null
        Copy-Item -LiteralPath $executable -Destination $probe
        if ((Get-Sha256 $probe) -cne $expected[0].Substring(0, 64)) { throw 'The connection checker does not match this FORGE Setup.' }
        Invoke-DatabaseCheck $probe $Arguments $Secret
    } finally {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $probeRoot -Force -ErrorAction SilentlyContinue
    }
}

function Assert-WorkbenchPort([int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.ExclusiveAddressUse = $true
    try { $listener.Start() }
    catch [Net.Sockets.SocketException] { throw "Local Workbench port $Port is occupied. Close the application using it or choose another port." }
    finally { $listener.Stop() }
}

$sourceRoot = [IO.Path]::GetFullPath($DistributionRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$ConfigRoot = [IO.Path]::GetFullPath($ConfigRoot)
Assert-SafeManagedPath $InstallRoot 'InstallRoot'
Assert-SafeManagedPath $ConfigRoot 'ConfigRoot'
$InstallRoot = $InstallRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)
$ConfigRoot = $ConfigRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($ConfigRoot -eq $InstallRoot -or $ConfigRoot.StartsWith($InstallRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $InstallRoot.StartsWith($ConfigRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallRoot and ConfigRoot must be separate directories.'
}
if ($InstallRoot -eq $sourceRoot -or $InstallRoot.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'InstallRoot must be outside the extracted release package.' }
foreach ($requiredName in @('FORGE-Workbench.exe', 'Launch-FORGE-Workbench.vbs', 'Uninstall-FORGE-Workbench.ps1', 'Export-FORGE-Diagnostics.ps1', 'RELEASE.json', 'public')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $requiredName))) { throw "Missing distribution path: $requiredName" }
}
if (-not $SkipPackageVerification) { Test-Distribution $sourceRoot }

$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [Threading.Mutex]::new($false, "Local\FORGE-Workbench-Setup-$userSid")
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another FORGE Workbench setup is running.' }

    $release = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $sourceRoot 'RELEASE.json') | ConvertFrom-Json
    if ($release.product -ne 'FORGE Workbench' -or [string]::IsNullOrWhiteSpace([string]$release.version)) { throw 'Release metadata is invalid.' }
    $incomingVersion = [string]$release.version
    $existingReleasePath = Join-Path $InstallRoot 'RELEASE.json'
    $isUpgrade = Test-Path -LiteralPath $InstallRoot -PathType Container
    if ($isUpgrade -and (Test-Path -LiteralPath $existingReleasePath -PathType Leaf)) {
        try { $installedVersion = [string](Get-Content -Raw -Encoding UTF8 -LiteralPath $existingReleasePath | ConvertFrom-Json).version }
        catch { throw 'Installed FORGE release metadata is invalid; refusing an unsafe update.' }
        if (-not $AllowDowngrade -and (Get-VersionKey $incomingVersion) -lt (Get-VersionKey $installedVersion)) { throw "Refusing to downgrade FORGE Workbench from $installedVersion to $incomingVersion without -AllowDowngrade." }
    }
    $configPath = Join-Path $ConfigRoot 'workbench.json'
    $existingConfig = $null
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        try { $existingConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json }
        catch { throw 'Existing FORGE shared configuration is invalid; refusing to overwrite it.' }
    }
    $existingDatabase = if ($null -ne $existingConfig) { $existingConfig.database } else { $null }
    $existingWorkbench = if ($null -ne $existingConfig -and $null -ne $existingConfig.PSObject.Properties['workbench']) { $existingConfig.workbench } else { $null }
    $savedPort = if ($null -ne $existingWorkbench -and $null -ne $existingWorkbench.PSObject.Properties['port']) { [int]$existingWorkbench.port } else { 7334 }
    if ($ConnectionOnly -and (-not $Reconfigure -or -not $isUpgrade -or $null -eq $existingConfig)) {
        throw 'Changing only the connection requires an existing installation and -Reconfigure.'
    }
    if (($Reconfigure -or $Inspect) -and $null -ne $existingDatabase) {
        if (-not $PSBoundParameters.ContainsKey('DatabaseHost')) { $DatabaseHost = [string]$existingDatabase.host }
        if (-not $PSBoundParameters.ContainsKey('DatabasePort') -and $null -ne $existingDatabase.PSObject.Properties['port']) { $DatabasePort = [int]$existingDatabase.port }
        if (-not $PSBoundParameters.ContainsKey('DatabaseName')) { $DatabaseName = [string]$existingDatabase.name }
        if (-not $PSBoundParameters.ContainsKey('DatabaseUser')) { $DatabaseUser = [string]$existingDatabase.user }
        if (-not $PSBoundParameters.ContainsKey('CredentialFile') -and $null -ne $existingDatabase.PSObject.Properties['credentialFile']) { $CredentialFile = [string]$existingDatabase.credentialFile }
        if (-not $PSBoundParameters.ContainsKey('WorkbenchPort') -and $null -ne $existingWorkbench -and $null -ne $existingWorkbench.PSObject.Properties['port']) { $WorkbenchPort = [int]$existingWorkbench.port }
    }
    $connectionArguments = @('DatabaseHost','DatabasePort','DatabaseName','DatabaseUser','CredentialFile','WorkbenchPort','DatabasePassword')
    $connectionChangeRequested = @($connectionArguments | Where-Object { $PSBoundParameters.ContainsKey($_) }).Count -gt 0
    if ($null -ne $existingConfig -and -not $Reconfigure -and $connectionChangeRequested) { throw 'Updating connection settings requires -Reconfigure. A normal update preserves configuration and DPAPI credentials.' }
    if ($Inspect) {
        [pscustomobject]@{
            Existing = ($null -ne $existingConfig)
            Installed = $isUpgrade
            Version = $incomingVersion
            Signed = (Get-AuthenticodeSignature -LiteralPath (Join-Path $sourceRoot 'FORGE-Setup.exe')).Status -eq 'Valid'
            DatabaseHost = $DatabaseHost
            DatabasePort = $DatabasePort
            DatabaseName = $DatabaseName
            DatabaseUser = $DatabaseUser
            WorkbenchPort = $WorkbenchPort
        }
        return
    }
    $writeConfiguration = $Reconfigure -or $null -eq $existingConfig
    if (-not $writeConfiguration -and $connectionChangeRequested) { throw 'Changing saved connection settings requires -Reconfigure.' }
    if ($writeConfiguration) {
        Assert-CredentialFile $CredentialFile
        if ([string]::IsNullOrWhiteSpace($DatabaseHost) -or [string]::IsNullOrWhiteSpace($DatabaseName) -or [string]::IsNullOrWhiteSpace($DatabaseUser)) { throw 'Database host, name and user must not be blank.' }
        if ($null -eq $DatabasePassword) { $DatabasePassword = Read-Host 'PostgreSQL password for the FORGE runtime user' -AsSecureString }
        if ($DatabasePassword.Length -lt 1 -or $DatabasePassword.Length -gt 4096) { throw 'Enter a PostgreSQL password of 1 to 4096 characters.' }
    }
    if ($CheckOnly -or ($writeConfiguration -and (Test-Path -LiteralPath (Join-Path $sourceRoot 'FORGE-Setup.exe') -PathType Leaf))) {
        $arguments = if ($writeConfiguration) { @('entered', $DatabaseHost, [string]$DatabasePort, $DatabaseName, $DatabaseUser) } else { @('existing', $ConfigRoot) }
        Test-PackageConnection $sourceRoot $arguments $DatabasePassword
    }
    if ($CheckOnly) { Write-Output 'PostgreSQL connection and FORGE permissions verified.'; return }
    if ($ConnectionOnly -and $WorkbenchPort -ne $savedPort) { throw 'Changing only the connection preserves the Workbench port.' }
    $effectivePort = if ($writeConfiguration) { $WorkbenchPort } else { $savedPort }
    $installPrefix = $InstallRoot + [IO.Path]::DirectorySeparatorChar
    $running = @(Get-Process -Name 'FORGE-Workbench' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) })
    if (-not $NoLaunch -and ($running.Count -eq 0 -or $effectivePort -ne $savedPort)) { Assert-WorkbenchPort $effectivePort }
    $configurationTemporary = $null
    $credentialTemporary = $null
    $effectiveCredentialFile = $CredentialFile
    if (-not $writeConfiguration) {
        if ($null -ne $existingDatabase.PSObject.Properties['credentialFile']) { $effectiveCredentialFile = [string]$existingDatabase.credentialFile }
        Assert-CredentialFile $effectiveCredentialFile
        if (-not (Test-Path -LiteralPath (Join-Path $ConfigRoot $effectiveCredentialFile) -PathType Leaf)) { throw 'The preserved FORGE DPAPI credential is missing.' }
    }
    $parent = Split-Path -Parent $InstallRoot
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $transaction = [Guid]::NewGuid().ToString('N')
    $stagedRoot = Join-Path $parent ('.forge-workbench-stage-' + $transaction)
    $backupRoot = Join-Path $parent ('.forge-workbench-backup-' + $transaction)
    $configBackup = Join-Path $ConfigRoot ('.workbench-config-backup-' + $transaction)
    if ($writeConfiguration -and ($null -ne $existingConfig -or (Test-Path -LiteralPath (Join-Path $ConfigRoot $CredentialFile)))) {
        $CredentialFile = "workbench-$transaction.dpapi"
    }
    $credentialPath = Join-Path $ConfigRoot $CredentialFile
    $applicationMoved = $false
    $applicationPublished = $false
    $configurationPublished = $false
    $credentialPublished = $false
    try {
        if ($writeConfiguration) {
            New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null
            $token = [Guid]::NewGuid().ToString('N')
            $configurationTemporary = Join-Path $ConfigRoot ("workbench.$token.tmp")
            $credentialTemporary = Join-Path $ConfigRoot ("credential.$token.tmp")
            $config = [ordered]@{
                version = 1
                database = [ordered]@{ host=$DatabaseHost; port=$DatabasePort; name=$DatabaseName; user=$DatabaseUser; credentialFile=$CredentialFile }
                workbench = [ordered]@{ port=$WorkbenchPort }
            }
            if ($null -ne $existingConfig -and $null -ne $existingConfig.PSObject.Properties['embedding']) { $config['embedding'] = $existingConfig.embedding }
            [IO.File]::WriteAllText($configurationTemporary, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
            Write-Dpapi $DatabasePassword $credentialTemporary
        }
        if (-not $ConnectionOnly) {
            New-Item -ItemType Directory -Path $stagedRoot | Out-Null
            Get-ChildItem -LiteralPath $sourceRoot -Force | Copy-Item -Destination $stagedRoot -Recurse -Force
            if (-not $SkipPackageVerification) { Test-Distribution $stagedRoot }
        }
        $running | Stop-Process -Force
        if (-not $ConnectionOnly) {
            if (Test-Path -LiteralPath $InstallRoot) { Move-Item -LiteralPath $InstallRoot -Destination $backupRoot; $applicationMoved = $true }
            Move-Item -LiteralPath $stagedRoot -Destination $InstallRoot
            $applicationPublished = $true
        }
        if ($writeConfiguration) {
            [IO.File]::Move($credentialTemporary, $credentialPath)
            $credentialPublished = $true
            if ($null -ne $existingConfig) { [IO.File]::Replace($configurationTemporary, $configPath, $configBackup) }
            else { [IO.File]::Move($configurationTemporary, $configPath) }
            $configurationPublished = $true
        }
        if (-not $ConnectionOnly) {
            "http://127.0.0.1:$effectivePort" | Set-Content -LiteralPath (Join-Path $InstallRoot 'workbench.url') -Encoding ascii -NoNewline
        }
        if (-not $ConnectionOnly -and -not $NoShortcuts) {
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'FORGE Workbench.lnk'))
            $shortcut.TargetPath = Join-Path $InstallRoot 'FORGE-Setup.exe'
            $shortcut.Arguments = '--open-workbench'
            $shortcut.WorkingDirectory = $InstallRoot
            $shortcut.Description = 'Open FORGE Workbench'
            $shortcut.Save()
        }
        Remove-Item -LiteralPath $backupRoot, $configBackup -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        $failure = $_
        $rollbackFailed = $false
        try {
            if ($configurationPublished) {
                if ($null -ne $existingConfig) { [IO.File]::Replace($configBackup, $configPath, [Management.Automation.Language.NullString]::Value) }
                else { Remove-Item -LiteralPath $configPath -Force }
            }
            if ($credentialPublished) { Remove-Item -LiteralPath $credentialPath -Force }
        } catch { $rollbackFailed = $true }
        try {
            if ($applicationPublished) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
            if ($applicationMoved) { Move-Item -LiteralPath $backupRoot -Destination $InstallRoot }
        } catch { $rollbackFailed = $true }
        if ($rollbackFailed) {
            throw 'Setup failed and could not finish rollback. The previous application and configuration backups were retained for recovery.'
        }
        throw $failure
    } finally {
        @($stagedRoot, $configurationTemporary, $credentialTemporary) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
            Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction SilentlyContinue
        }
        $DatabasePassword = $null
    }
    $operation = if ($isUpgrade) { 'updated' } else { 'installed' }
    if ($ConnectionOnly) { Write-Output 'FORGE connection settings updated.' }
    else { Write-Output "FORGE Workbench $incomingVersion $operation in $InstallRoot" }
    if (-not $writeConfiguration) { Write-Output 'Existing configuration and CurrentUser DPAPI credential were preserved.' }
    else { Write-Output "Configuration stored in $ConfigRoot (password protected by CurrentUser DPAPI)" }
    if (-not $NoLaunch) {
        Start-Process -FilePath (Join-Path $InstallRoot 'FORGE-Setup.exe') -ArgumentList '--open-workbench' -WindowStyle Hidden
    }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
