[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$outputsRoot = Split-Path -Parent $packageRoot
$workspaceRoot = Split-Path -Parent $outputsRoot
$statusDirectory = Join-Path $workspaceRoot 'work'
$statusPath = Join-Path $statusDirectory 'forge-codex-registration.json'
$credentialRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'
$credentialPath = Join-Path $credentialRoot 'forge_test_runner.dpapi'
$checkScript = Join-Path $PSScriptRoot 'check-codex-registration.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$firstPointer = [IntPtr]::Zero
$secondPointer = [IntPtr]::Zero
$firstPlain = $null
$secondPlain = $null
$passwordBytes = $null
$protectedBytes = $null
$previousEncrypted = $null
$hadPreviousCredential = Test-Path -LiteralPath $credentialPath
$exitCode = 1

New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $credentialRoot | Out-Null

function Set-RegistrationStatus {
    param(
        [string]$Status,
        [string]$Detail
    )

    [pscustomobject]@{
        status = $Status
        detail = $Detail
        updated_at = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

Set-RegistrationStatus -Status 'RUNNING' -Detail 'Waiting for the runtime-role password.'

try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    if ($hadPreviousCredential) {
        $previousEncrypted = Get-Content -Raw -LiteralPath $credentialPath
    }

    Write-Host ''
    Write-Host 'FORGE MCP: secure Codex credential setup.' -ForegroundColor Cyan
    Write-Host 'The password will be encrypted for this Windows user with DPAPI.'
    $first = Read-Host 'Enter the forge_test_runner password' -AsSecureString
    $second = Read-Host 'Repeat the forge_test_runner password' -AsSecureString

    $firstPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($first)
    $secondPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($second)
    $firstPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPointer)
    $secondPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPointer)
    if ($firstPlain -cne $secondPlain) {
        throw 'The passwords do not match.'
    }

    $passwordBytes = [Text.Encoding]::UTF8.GetBytes($firstPlain)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $passwordBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $encrypted = [Convert]::ToBase64String($protectedBytes)
    Set-Content -LiteralPath $credentialPath -Value $encrypted -Encoding UTF8

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $currentSid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    [IO.File]::SetAccessControl($credentialPath, $acl)

    & $node $checkScript
    if ($LASTEXITCODE -ne 0) {
        throw "The Codex launcher validation failed with exit code $LASTEXITCODE."
    }

    Set-RegistrationStatus -Status 'PASS' -Detail 'DPAPI credential and exact Codex stdio launcher validated.'
    Write-Host ''
    Write-Host 'PASS: encrypted credential and MCP launcher validated.' -ForegroundColor Green
    $exitCode = 0
}
catch {
    if ($hadPreviousCredential -and $null -ne $previousEncrypted) {
        Set-Content -LiteralPath $credentialPath -Value $previousEncrypted -Encoding UTF8
    }
    elseif (Test-Path -LiteralPath $credentialPath) {
        Remove-Item -LiteralPath $credentialPath -Force
    }
    Set-RegistrationStatus -Status 'FAIL' -Detail $_.Exception.Message
    Write-Host ''
    Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    $firstPlain = $null
    $secondPlain = $null
    $first = $null
    $second = $null
    $encrypted = $null
    $previousEncrypted = $null
    if ($null -ne $passwordBytes) {
        [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    }
    if ($null -ne $protectedBytes) {
        [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
    }
    if ($firstPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPointer)
    }
    if ($secondPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPointer)
    }
}

Write-Host ''
Read-Host 'Press Enter to close this window'
exit $exitCode
