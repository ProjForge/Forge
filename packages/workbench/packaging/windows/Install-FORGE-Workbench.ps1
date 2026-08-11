[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\FORGE Workbench'),
    [string]$ConfigRoot = (Join-Path $env:APPDATA 'FORGE'),
    [string]$DatabaseHost = '127.0.0.1',
    [ValidateRange(1, 65535)][int]$DatabasePort = 5432,
    [string]$DatabaseName = 'forge_test',
    [string]$DatabaseUser = 'forge_test_runner',
    [ValidateRange(1, 65535)][int]$WorkbenchPort = 7334,
    [Security.SecureString]$DatabasePassword,
    [switch]$NoShortcuts,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($DatabaseHost) -or [string]::IsNullOrWhiteSpace($DatabaseName) -or [string]::IsNullOrWhiteSpace($DatabaseUser)) {
    throw 'Database host, name and user must not be blank.'
}

$sourceRoot = Split-Path -Parent $PSCommandPath
$sourceExe = Join-Path $sourceRoot 'FORGE-Workbench.exe'
$sourceLauncher = Join-Path $sourceRoot 'Launch-FORGE-Workbench.vbs'
$sourceUninstaller = Join-Path $sourceRoot 'Uninstall-FORGE-Workbench.ps1'
foreach ($required in $sourceExe, $sourceLauncher, $sourceUninstaller) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing distribution file: $required" }
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null
Copy-Item -LiteralPath $sourceExe, $sourceLauncher, $sourceUninstaller -Destination $InstallRoot -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'public') -Destination $InstallRoot -Recurse -Force
"http://127.0.0.1:$WorkbenchPort" | Set-Content -LiteralPath (Join-Path $InstallRoot 'workbench.url') -Encoding ascii -NoNewline

$config = [ordered]@{
    database = [ordered]@{
        host = $DatabaseHost
        port = $DatabasePort
        name = $DatabaseName
        user = $DatabaseUser
        credentialFile = 'workbench.dpapi'
    }
    workbench = [ordered]@{ port = $WorkbenchPort }
}
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $ConfigRoot 'workbench.json') -Encoding utf8

if ($null -eq $DatabasePassword) {
    $DatabasePassword = Read-Host 'PostgreSQL password for the FORGE runtime user' -AsSecureString
}

Add-Type -AssemblyName System.Security
$bstr = [IntPtr]::Zero
$plainBytes = $null
$protectedBytes = $null
try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DatabasePassword)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($plain)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Convert]::ToBase64String($protectedBytes) | Set-Content -LiteralPath (Join-Path $ConfigRoot 'workbench.dpapi') -NoNewline
} finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    $plain = $null
}

if (-not $NoShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'FORGE Workbench.lnk'
    $shortcut = $shell.CreateShortcut($startMenu)
    $shortcut.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe')
    $shortcut.Arguments = '//nologo "' + (Join-Path $InstallRoot 'Launch-FORGE-Workbench.vbs') + '"'
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.Description = 'Open FORGE Workbench'
    $shortcut.Save()
}

Write-Output "FORGE Workbench installed in $InstallRoot"
Write-Output "Configuration stored in $ConfigRoot (password protected by CurrentUser DPAPI)"
if (-not $NoLaunch) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList '//nologo', ('"' + (Join-Path $InstallRoot 'Launch-FORGE-Workbench.vbs') + '"') -WindowStyle Hidden
}
