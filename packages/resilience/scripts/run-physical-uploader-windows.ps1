[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [ValidateRange(1,256)][int]$MaxItems = 16,
    [switch]$PackageOnly
)

$ErrorActionPreference = 'Stop'
$runtime = Get-Content -LiteralPath (Join-Path $ConfigRoot 'resilience-runtime.json') -Raw | ConvertFrom-Json
$physical = Get-Content -LiteralPath (Join-Path $ConfigRoot 'pitr-runtime.json') -Raw | ConvertFrom-Json
$secretPath = Join-Path $ConfigRoot 'resilience-physical-passphrase.dpapi'
$accessPath = Join-Path $ConfigRoot 'resilience-aws-access-key-id.dpapi'
$secretKeyPath = Join-Path $ConfigRoot 'resilience-aws-secret-access-key.dpapi'
$walRoot = Join-Path ([IO.Path]::GetFullPath($PitrRoot)) 'wal'
$encryptedRoot = Join-Path ([IO.Path]::GetFullPath($PitrRoot)) 'encrypted'
$receiptRoot = Join-Path ([IO.Path]::GetFullPath($PitrRoot)) 'receipts'
$statusRoot = Join-Path ([IO.Path]::GetFullPath($PitrRoot)) 'status'
$validWalName = '^(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$'
$protectedValues = [Collections.Generic.List[byte[]]]::new()
$plainValues = [Collections.Generic.List[byte[]]]::new()

function Read-Dpapi([string]$Path) {
    $protected = [Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $protectedValues.Add($protected)
    $plainValues.Add($plain)
    return [Text.Encoding]::UTF8.GetString($plain)
}

function Write-AtomicJson([string]$Path, [object]$Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $Value | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $temporary -Encoding utf8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

New-Item -ItemType Directory -Force -Path $encryptedRoot,$receiptRoot,$statusRoot | Out-Null
$statusPath = Join-Path $statusRoot 'physical-uploader.json'
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $env:FORGE_BACKUP_PASSPHRASE = Read-Dpapi $secretPath
    if (-not $PackageOnly) {
        $env:AWS_ACCESS_KEY_ID = Read-Dpapi $accessPath
        $env:AWS_SECRET_ACCESS_KEY = Read-Dpapi $secretKeyPath
        $env:AWS_REGION = [string]$physical.s3.region
    }
    $files = @(Get-ChildItem -LiteralPath $walRoot -File | Where-Object Name -Match $validWalName | Sort-Object Name | Select-Object -First $MaxItems)
    $results = foreach ($file in $files) {
        $label = "wal-$($file.Name)"
        $manifestPath = Join-Path $encryptedRoot "$label.forge-physical.json"
        $receiptPath = Join-Path $receiptRoot "$label.receipt.json"
        if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
            [ordered]@{ wal=$file.Name; status='already-receipted' }
            continue
        }
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            & ([string]$runtime.nodePath) ([string]$runtime.cliPath) physical-pack `
                --kind wal --source $file.FullName --output $encryptedRoot --label $label `
                --system-identifier ([string]$physical.cluster.systemIdentifier) `
                --timeline ([string]$physical.cluster.timeline) `
                --server-version ([string]$physical.cluster.serverVersion) `
                --server-version-number ([string]$physical.cluster.serverVersionNumber) | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Physical packaging failed for $($file.Name)." }
        }
        & ([string]$runtime.nodePath) ([string]$runtime.cliPath) physical-verify --manifest $manifestPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Physical verification failed for $($file.Name)." }
        if ($PackageOnly) {
            [ordered]@{ wal=$file.Name; status='packaged'; manifest=$manifestPath }
            continue
        }
        $upload = & ([string]$runtime.nodePath) ([string]$runtime.cliPath) physical-upload-s3 `
            --manifest $manifestPath --config ([string]$physical.policyPath) --target ([string]$physical.s3.target)
        if ($LASTEXITCODE -ne 0) { throw "Physical upload failed for $($file.Name)." }
        $remote = $upload | ConvertFrom-Json
        Write-AtomicJson $receiptPath ([ordered]@{
            format='forge-physical-receipt'; version=1; wal=$file.Name
            manifestLocation=$remote.manifestLocation; payloadLocation=$remote.payloadLocation
            authenticatedAt=(Get-Date).ToUniversalTime().ToString('o')
        })
        [ordered]@{ wal=$file.Name; status='authenticated'; receipt=$receiptPath }
    }
    Write-AtomicJson $statusPath ([ordered]@{ status='PASS'; startedAt=$startedAt; completedAt=(Get-Date).ToUniversalTime().ToString('o'); packageOnly=[bool]$PackageOnly; results=@($results) })
    $results | ConvertTo-Json -Depth 6
}
catch {
    Write-AtomicJson $statusPath ([ordered]@{ status='FAIL'; startedAt=$startedAt; completedAt=(Get-Date).ToUniversalTime().ToString('o'); error=$_.Exception.Message })
    throw
}
finally {
    Remove-Item Env:FORGE_BACKUP_PASSPHRASE,Env:AWS_ACCESS_KEY_ID,Env:AWS_SECRET_ACCESS_KEY,Env:AWS_REGION -ErrorAction SilentlyContinue
    foreach ($plain in $plainValues) { [Array]::Clear($plain,0,$plain.Length) }
    foreach ($protected in $protectedValues) { [Array]::Clear($protected,0,$protected.Length) }
}
