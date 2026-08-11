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
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash) {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    throw "Restored WAL verification failed: $FileName"
}
