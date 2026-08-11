[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$FileName,
    [Parameter(Mandatory)][string]$ArchiveDirectory
)

$ErrorActionPreference = 'Stop'
$validWalName = '^(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$'
if ([IO.Path]::GetFileName($FileName) -ne $FileName -or $FileName -notmatch $validWalName) {
    throw "Unsafe WAL archive file name: $FileName"
}
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "WAL source does not exist: $Source" }

New-Item -ItemType Directory -Force -Path $ArchiveDirectory | Out-Null
$target = Join-Path $ArchiveDirectory $FileName

function Get-SharedSha256([string]$Path) {
    $stream = [IO.FileStream]::new(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    )
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}

if (Test-Path -LiteralPath $target) {
    if ((Get-SharedSha256 $Source) -eq (Get-SharedSha256 $target)) {
        exit 0
    }
    throw "WAL archive collision with different content: $FileName"
}

$partial = "$target.$PID.partial"
try {
    Copy-Item -LiteralPath $Source -Destination $partial -ErrorAction Stop
    if ((Get-SharedSha256 $Source) -ne (Get-SharedSha256 $partial)) {
        throw "WAL archive verification failed: $FileName"
    }
    if (Test-Path -LiteralPath $target) { throw "WAL archive target appeared concurrently: $FileName" }
    Move-Item -LiteralPath $partial -Destination $target -ErrorAction Stop
}
finally {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
}
