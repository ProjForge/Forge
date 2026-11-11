[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SessionDirectory,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$session = Get-Item -LiteralPath $SessionDirectory
if (!$session.PSIsContainer -or ($session.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Expected the destination rehearsal session'
}
$outbox = Join-Path $session.FullName 'outbox'
$inbox = Join-Path $session.FullName 'inbox'
foreach ($directory in @($outbox,$inbox)) {
    $item = Get-Item -LiteralPath $directory
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Session subdirectory is redirected'
    }
}
$recipient = Get-Content -LiteralPath (Join-Path $outbox 'recipient.json') -Raw | ConvertFrom-Json
$replica = Join-Path $inbox 'handoff'
& (Join-Path $PSScriptRoot 'input/node.exe') (Join-Path $PSScriptRoot 'input/check-handoff.mjs') $replica $recipient.runId $recipient.recipientSha256 $ManifestSha256
if ($LASTEXITCODE -ne 0) { throw 'Handoff rejected before submitting restore request' }
if ($VerifyOnly) { return }

$id = (Get-Content -LiteralPath (Join-Path $session.FullName 'sandbox-id.txt') -Raw).Trim()
if ($id -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Invalid Sandbox instance ID' }
$instances = (& wsb.exe list --raw | Out-String)
if ($LASTEXITCODE -ne 0 -or $instances -notmatch [regex]::Escape($id)) {
    throw 'Destination Sandbox is inactive. Its key cannot be recovered.'
}
$pending = Join-Path $inbox ('request-' + [guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($pending, $ManifestSha256, [Text.Encoding]::ASCII)
try {
    [IO.File]::Move($pending, (Join-Path $inbox 'restore.sha256'))
} finally {
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending }
}
