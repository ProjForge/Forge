[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RecoveryDirectory,
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE')
)

$ErrorActionPreference = 'Stop'
$recoveryRoot = [IO.Path]::GetFullPath($RecoveryDirectory)
$offlinePath = Join-Path $recoveryRoot 'FORGE-Physical-Recovery-Passphrase.txt'
$checksumPath = Join-Path $recoveryRoot 'SHA256SUMS.txt'
$dpapiPath = Join-Path ([IO.Path]::GetFullPath($ConfigRoot)) 'resilience-physical-passphrase.dpapi'
if (-not (Test-Path -LiteralPath $recoveryRoot -PathType Container)) { throw 'Recovery directory does not exist.' }
if ((Test-Path -LiteralPath $offlinePath) -or (Test-Path -LiteralPath $dpapiPath)) {
    throw 'Physical recovery passphrase already exists; refusing to overwrite it.'
}

function Test-FixedTimeEqual([byte[]]$Left, [byte[]]$Right) {
    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ($Left[$index] -bxor $Right[$index])
    }
    return $difference -eq 0
}

$secret = $null
$protected = $null
$random = $null
$offlinePublished = $false
$dpapiPublished = $false
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $secret = New-Object byte[] 48
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $random.GetBytes($secret)
    $encoded = [Convert]::ToBase64String($secret)
    $protected = [Security.Cryptography.ProtectedData]::Protect($secret,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null

    [Convert]::ToBase64String($protected) | Set-Content -LiteralPath $dpapiPath -Encoding ascii -NoNewline
    $dpapiPublished = $true
    @(
        'FORGE physical recovery passphrase'
        ''
        $encoded
        ''
        'Required to authenticate and decrypt physical WAL/base-backup packages.'
        'Store a second copy in a trusted password manager; never commit this file.'
    ) | Set-Content -LiteralPath $offlinePath -Encoding utf8
    $offlinePublished = $true

    $roundTripProtected = [Convert]::FromBase64String((Get-Content -LiteralPath $dpapiPath -Raw).Trim())
    $roundTrip = [Security.Cryptography.ProtectedData]::Unprotect($roundTripProtected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        if (-not (Test-FixedTimeEqual $secret $roundTrip)) {
            throw 'DPAPI physical passphrase verification failed.'
        }
        if ((Get-Content -LiteralPath $offlinePath -Raw) -notmatch [regex]::Escape($encoded)) {
            throw 'Offline physical passphrase verification failed.'
        }
    }
    finally {
        [Array]::Clear($roundTrip,0,$roundTrip.Length)
        [Array]::Clear($roundTripProtected,0,$roundTripProtected.Length)
    }

    Get-ChildItem -LiteralPath $recoveryRoot -File | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object Name |
        Get-FileHash -Algorithm SHA256 | ForEach-Object {
            "$($_.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_.Path))"
        } | Set-Content -LiteralPath $checksumPath -Encoding ascii

    [ordered]@{
        status = 'PASS'
        dpapiPath = $dpapiPath
        offlinePath = $offlinePath
        secretBytes = $secret.Length
        verified = $true
    } | ConvertTo-Json
}
catch {
    if ($offlinePublished) { Remove-Item -LiteralPath $offlinePath -Force -ErrorAction SilentlyContinue }
    if ($dpapiPublished) { Remove-Item -LiteralPath $dpapiPath -Force -ErrorAction SilentlyContinue }
    throw
}
finally {
    if ($secret) { [Array]::Clear($secret,0,$secret.Length) }
    if ($protected) { [Array]::Clear($protected,0,$protected.Length) }
    if ($random) { $random.Dispose() }
    $encoded = $null
}
