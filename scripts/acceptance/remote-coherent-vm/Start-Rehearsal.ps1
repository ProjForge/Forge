[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Source','Destination')][string]$Role,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$RunId,
    [Parameter(Mandatory)][string]$SessionDirectory,
    [string]$PublicKey,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$RecipientSha256,
    [switch]$PlanOnly
)
$ErrorActionPreference = 'Stop'
if ($Role -eq 'Source' -and (!$PublicKey -or !$RecipientSha256)) {
    throw 'Source requires -PublicKey and an independently verified -RecipientSha256'
}
if ($Role -eq 'Destination' -and ($PublicKey -or $RecipientSha256)) {
    throw 'Destination generates its own key'
}
$session = [IO.Path]::GetFullPath($SessionDirectory)
if ($session -notmatch '^[a-zA-Z]:\\' -or (Test-Path -LiteralPath $session)) {
    throw 'SessionDirectory must be a new directory on a local drive'
}
$parent = Split-Path -Parent $session
if (!(Test-Path -LiteralPath $parent -PathType Container)) { throw 'SessionDirectory parent must exist' }
for ($item = Get-Item -LiteralPath $parent; $item; $item = $item.Parent) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SessionDirectory parent is redirected' }
}
if ($PublicKey) {
    $keyFile = Get-Item -LiteralPath $PublicKey
    if ($keyFile.PSIsContainer -or ($keyFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $keyFile.Length -gt 4096) {
        throw 'PublicKey must be an ordinary file'
    }
    $pem = [IO.File]::ReadAllText($keyFile.FullName)
    if ($pem -cnotmatch '\A-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?\z') {
        throw 'Provide only a PEM-encoded public key'
    }
}
$inputDir = Join-Path $PSScriptRoot 'input'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'sandbox-config.xml') -Raw
$xml = [xml]$config
if ($xml.Configuration.Networking -ne 'Disable' -or $xml.Configuration.ClipboardRedirection -ne 'Disable' -or $xml.Configuration.MappedFolders) {
    throw 'Expected the offline Sandbox configuration'
}
foreach ($file in @('node.exe','probe.mjs','database.mjs','guest.ps1','role.ps1','remote-coherent-transfer.mjs',
                     'postgres/bin/pg_dump.exe','postgres/bin/pg_restore.exe','postgres/lib/vector.dll')) {
    if (!(Test-Path -LiteralPath (Join-Path $inputDir $file) -PathType Leaf)) { throw "Kit file missing: $file" }
}
$wsb = (Get-Command wsb.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if ($PlanOnly) {
    [pscustomobject]@{ mode = 'plan-only'; role = $Role; runId = $RunId; session = $session; sandboxCliFound = [bool]$wsb }
    return
}
if (!$wsb) { throw 'This rehearsal requires Windows Sandbox CLI' }
if ((Get-Volume -DriveLetter $session[0]).FileSystem -ne 'NTFS') { throw 'Use an NTFS session drive' }

New-Item -ItemType Directory -Path $session | Out-Null
$inbox = Join-Path $session 'inbox'
$outbox = Join-Path $session 'outbox'
New-Item -ItemType Directory -Path $inbox,$outbox | Out-Null
if ($PublicKey) {
    Copy-Item -LiteralPath $keyFile.FullName -Destination (Join-Path $inbox 'public.pem')
}
$instance = [guid]::NewGuid().ToString()
$bootstrap = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bootstrap.ps1') -Raw
$command = "& { $bootstrap } -HostRole $Role -RunId $RunId"
if ($RecipientSha256) { $command += " -RecipientSha256 $RecipientSha256" }
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$owned = $false
try {
    & $wsb start --id $instance -c $config --raw | Set-Content (Join-Path $session 'sandbox-start.json')
    if ($LASTEXITCODE -ne 0) { throw 'Sandbox start failed' }
    $owned = $true
    Set-Content -LiteralPath (Join-Path $session 'sandbox-id.txt') -Value $instance -Encoding ASCII
    & $wsb share --id $instance -f $inputDir -s 'C:\FixtureInput' --raw | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Kit mount failed' }
    & $wsb share --id $instance -f $inbox -s 'C:\FixtureInbox' --raw | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Inbox mount failed' }
    & $wsb share --id $instance -f $outbox -s 'C:\FixtureOutput' -w --raw | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Outbox mount failed' }
    & $wsb exec --id $instance -r System -c "powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded" --raw |
        Set-Content (Join-Path $session 'guest-exit.json')
    if ($LASTEXITCODE -ne 0) { throw 'Sandbox execution failed' }
    $guest = Get-Content -LiteralPath (Join-Path $session 'guest-exit.json') -Raw | ConvertFrom-Json
    $result = Get-Content -LiteralPath (Join-Path $outbox 'result.json') -Raw | ConvertFrom-Json
    if ($null -eq $guest.ExitCode -or $guest.ExitCode -ne 0 -or !$result.passed -or !$result.accountsRemoved) {
        throw 'Rehearsal failed. Review the sanitized outbox result.'
    }
    $result
} finally {
    if ($owned) {
        & $wsb stop --id $instance --raw | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Check closure of the owned Sandbox $instance" }
        $instances = (& $wsb list --raw | Out-String)
        if ($LASTEXITCODE -ne 0 -or $instances -match [regex]::Escape($instance)) {
            throw "Could not confirm closure of the owned Sandbox $instance"
        }
        @{ sandboxClosed = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $session 'cleanup.json')
    }
}
