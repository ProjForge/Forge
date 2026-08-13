[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$FileName,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$ArchiveDirectory
)

$ErrorActionPreference = 'Stop'
$validWalName = '^(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$'
if ([IO.Path]::GetFileName($FileName) -ne $FileName -or $FileName -notmatch $validWalName) {
    throw "Unsafe WAL restore file name: $FileName"
}
$source = Join-Path $ArchiveDirectory $FileName
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { exit 1 }
Copy-Item -LiteralPath $source -Destination $Destination -ErrorAction Stop
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-','') }
    finally { $sha256.Dispose(); $stream.Dispose() }
}
if ((Get-Sha256 $source) -ne (Get-Sha256 $Destination)) {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    throw "Restored WAL verification failed: $FileName"
}
