[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\FORGE Workbench'),
    [string]$ConfigRoot = (Join-Path $env:APPDATA 'FORGE'),
    [string]$OutputPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) ('FORGE-Diagnostics-{0}.zip' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($OutputPath) -ne '.zip') { throw 'OutputPath must use the .zip extension.' }
if ((Test-Path -LiteralPath $OutputPath) -and -not $Force) { throw 'The diagnostics archive already exists. Use -Force to replace it.' }

function Read-JsonSafe([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }
    catch { return [pscustomobject]@{ invalid = $true } }
}

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-OptionalProperty($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-AllowedValue($Value, [string[]]$Allowed) {
    $text = [string]$Value
    if ($text -in $Allowed) { return $text }
    return $null
}

function Get-IsoTimestamp($Value) {
    $parsed = [DateTime]::MinValue
    if ([DateTime]::TryParse([string]$Value, [ref]$parsed)) { return $parsed.ToUniversalTime().ToString('o') }
    return $null
}

$release = Read-JsonSafe (Join-Path $InstallRoot 'RELEASE.json')
$config = Read-JsonSafe (Join-Path $ConfigRoot 'workbench.json')
$bootstrap = Read-JsonSafe (Join-Path $ConfigRoot 'bootstrap-status.json')
$signatureStatus = 'missing'
$executable = Join-Path $InstallRoot 'FORGE-Workbench.exe'
if (Test-Path -LiteralPath $executable -PathType Leaf) { $signatureStatus = [string](Get-AuthenticodeSignature -LiteralPath $executable).Status }

$tasks = @()
if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $knownTaskNames = @('FORGE Embedding Worker','FORGE Verified Recovery Backup','FORGE PITR WAL Uploader','FORGE PITR Daily Base Backup','FORGE PITR Monitor')
    $tasks = @($knownTaskNames | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } | ForEach-Object {
        $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        [ordered]@{
            name = [string]$_.TaskName
            state = [string]$_.State
            lastResult = if ($null -ne $info) { [int64]$info.LastTaskResult } else { $null }
            lastRunUtc = if ($null -ne $info -and $info.LastRunTime -gt [DateTime]::MinValue) { $info.LastRunTime.ToUniversalTime().ToString('o') } else { $null }
            nextRunUtc = if ($null -ne $info -and $info.NextRunTime -gt [DateTime]::MinValue) { $info.NextRunTime.ToUniversalTime().ToString('o') } else { $null }
        }
    })
}
$services = @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | ForEach-Object {
    $safeName = if ([string]$_.Name -match '^postgresql-x64-\d{2}$') { [string]$_.Name } else { 'postgresql-custom' }
    [ordered]@{ name=$safeName; status=[string]$_.Status; startType=[string]$_.StartType }
})
$os = Get-CimInstance Win32_OperatingSystem
$releaseValid = $null -ne $release -and -not ($release.PSObject.Properties.Name -contains 'invalid')
$configValid = $null -ne $config -and -not ($config.PSObject.Properties.Name -contains 'invalid')
$bootstrapValid = $null -ne $bootstrap -and -not ($bootstrap.PSObject.Properties.Name -contains 'invalid')
$databaseConfig = if ($configValid) { Get-OptionalProperty $config 'database' } else { $null }
$workbenchConfig = if ($configValid) { Get-OptionalProperty $config 'workbench' } else { $null }
$embeddingConfig = if ($configValid) { Get-OptionalProperty $config 'embedding' } else { $null }
$credentialFile = Get-OptionalProperty $databaseConfig 'credentialFile'
$rerankerModel = Get-OptionalProperty $embeddingConfig 'rerankerModel'
$releaseVersion = [string](Get-OptionalProperty $release 'version')
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+(?:-rc\.\d+)?$') { $releaseVersion = $null }
$sourceCommit = [string](Get-OptionalProperty $release 'sourceCommit')
if ($sourceCommit -notmatch '^[0-9a-f]{40}$') { $sourceCommit = $null }
$bootstrapStatus = Get-AllowedValue (Get-OptionalProperty $bootstrap 'status') @('PASS','FAIL','RUNNING','ROLLED_BACK')
$bootstrapPhase = Get-AllowedValue (Get-OptionalProperty $bootstrap 'phase') @('preflight','dependencies','build','database','runtime-config','codex-mcp','embedding-worker','workbench','logical-recovery','rollback','complete')
$diagnostics = [ordered]@{
    formatVersion = 1
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    privacy = 'allowlist-only; no raw logs, configuration, credentials, database content, usernames or hostnames'
    platform = [ordered]@{
        os = [string]$os.Caption
        version = [string]$os.Version
        build = [string]$os.BuildNumber
        architecture = [string]$env:PROCESSOR_ARCHITECTURE
        powerShell = [string]$PSVersionTable.PSVersion
    }
    release = [ordered]@{
        installed = $releaseValid
        version = if ($releaseValid) { $releaseVersion } else { $null }
        sourceCommit = if ($releaseValid) { $sourceCommit } else { $null }
        authenticode = $signatureStatus
        executableSha256 = Get-FileSha256 $executable
    }
    configuration = [ordered]@{
        present = $null -ne $config
        valid = $configValid
        databaseConfigured = $null -ne $databaseConfig
        credentialPresent = $null -ne $databaseConfig -and -not [string]::IsNullOrWhiteSpace([string]$credentialFile) -and (Test-Path -LiteralPath (Join-Path $ConfigRoot ([string]$credentialFile)) -PathType Leaf)
        workbenchConfigured = $null -ne $workbenchConfig
        embeddingConfigured = $null -ne $embeddingConfig
        precisionConfigured = -not [string]::IsNullOrWhiteSpace([string]$rerankerModel)
    }
    bootstrap = [ordered]@{
        present = $null -ne $bootstrap
        valid = $bootstrapValid
        status = if ($bootstrapValid) { $bootstrapStatus } else { $null }
        phase = if ($bootstrapValid) { $bootstrapPhase } else { $null }
        completedPhaseCount = if ($bootstrapValid) { @(Get-OptionalProperty $bootstrap 'completed').Count } else { 0 }
        updatedAt = if ($bootstrapValid) { Get-IsoTimestamp (Get-OptionalProperty $bootstrap 'updatedAt') } else { $null }
    }
    postgresqlServices = $services
    scheduledTasks = $tasks
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('forge-diagnostics-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $temporaryRoot 'diagnostics.json'), ($diagnostics | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    @(
        'FORGE diagnostics support bundle'
        'This archive is generated from an explicit allowlist.'
        'It contains no raw logs, configuration files, DPAPI material, database content, usernames or hostnames.'
    ) | Set-Content -LiteralPath (Join-Path $temporaryRoot 'README.txt') -Encoding ascii
    $outputParent = Split-Path -Parent $OutputPath
    if (-not [string]::IsNullOrWhiteSpace($outputParent)) { New-Item -ItemType Directory -Path $outputParent -Force | Out-Null }
    Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $temporaryRoot '*') -DestinationPath $OutputPath -CompressionLevel Optimal
} finally { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue }
Write-Output $OutputPath
