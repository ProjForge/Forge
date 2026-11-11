[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$RunId,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
    [switch]$VerifyOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($RunId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
    $ManifestSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Lowercase run UUID and manifest SHA-256 required' }
function Assert-SafeTree([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $ancestor = $item
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected path forbidden' }
        if ($ancestor -is [IO.DirectoryInfo]) { $ancestor = $ancestor.Parent } else { $ancestor = $ancestor.Directory }
    }
    $pending = New-Object 'Collections.Generic.Queue[object]'
    $pending.Enqueue(@($item.FullName, 0))
    $count = 0
    while ($pending.Count) {
        $entry = $pending.Dequeue()
        $child = Get-Item -LiteralPath $entry[0] -Force
        if ((++$count) -gt 100000 -or $entry[1] -gt 64) { throw 'Traversal limit exceeded' }
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point forbidden' }
        if ($child.PSIsContainer) {
            foreach ($nested in Get-ChildItem -LiteralPath $child.FullName -Force) {
                $pending.Enqueue(@($nested.FullName, ($entry[1] + 1)))
            }
        }
    }
}
$inputPath = Join-Path $PSScriptRoot 'input'
Assert-SafeTree $inputPath
Assert-SafeTree 'C:\FixtureInbox'
Assert-SafeTree 'C:\FixtureOutput'
$handoff = 'C:\FixtureInbox\handoff'
if (!(Test-Path -LiteralPath $handoff -PathType Container)) { throw 'Missing handoff directory' }
$recipient = Get-Content -LiteralPath 'C:\FixtureOutput\recipient.json' -Raw -Encoding UTF8 | ConvertFrom-Json
if ($recipient.runId -cne $RunId -or $recipient.recipientSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Recipient does not match the explicit expected run'
}
$node = Join-Path $inputPath 'node.exe'
$checker = Join-Path $inputPath 'check-handoff.mjs'
foreach ($file in @($node, $checker)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Missing kit verifier' }
}
& $node $checker $handoff $RunId $recipient.recipientSha256 $ManifestSha256
if ($LASTEXITCODE -ne 0) { throw 'Handoff rejected before submitting restore request' }
if ($VerifyOnly) {
    Write-Output 'Handoff verified; no restore request or task mutation.'
    return
}
$taskName = 'ForgePreprodRestore-' + $RunId
$task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
$expectedExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$expectedArguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File C:\ForgeFixtureInput\guest.ps1 -HostRole Destination -RunId $RunId -DestinationVm"
if ($task.State -ne 'Running' -or @($task.Actions).Count -ne 1 -or
    $task.Actions[0].Execute -ine $expectedExecutable -or
    $task.Actions[0].Arguments -cne $expectedArguments -or
    $task.Actions[0].WorkingDirectory -ine 'C:\ForgeFixtureInput' -or
    $task.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or
    $task.Principal.LogonType -ne 'ServiceAccount' -or $task.Principal.RunLevel -ne 'Highest') {
    throw 'Exact owned SYSTEM destination task must be Running'
}
$request = 'C:\FixtureInbox\restore.sha256'
if (Test-Path -LiteralPath $request) { throw 'A restore request already exists' }
$pending = Join-Path 'C:\FixtureInbox' ('request-' + $RunId + '-' + [guid]::NewGuid().ToString('N'))
$created = $false
try {
    # CreateNew plus same-directory Move never overwrites an existing request.
    $stream = [IO.File]::Open($pending, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $created = $true
    try {
        $bytes = [Text.Encoding]::ASCII.GetBytes($ManifestSha256)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    if ((Get-ScheduledTask -TaskName $taskName -TaskPath '\').State -ne 'Running') {
        throw 'Destination task stopped before request publication'
    }
    [IO.File]::Move($pending, $request)
    Write-Output "Restore request published for run $RunId"
} finally {
    if ($created -and (Test-Path -LiteralPath $pending)) { Remove-Item -LiteralPath $pending -Force }
}
