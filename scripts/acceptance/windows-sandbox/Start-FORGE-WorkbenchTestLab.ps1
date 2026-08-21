[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [string]$NodeRoot,
    [string]$PostgresRoot,
    [string]$OutputRoot,
    [string]$ReleaseArchive,
    [string]$ReleaseVersion = '0.2.0-rc.4',
    [string]$ReleaseSha256 = 'A3BDDEDC78BE78B675BD2A450584BEA9AB675CB7F892B54C96A70BA5E3F36C25',
    [ValidateRange(5, 60)][int]$TimeoutMinutes = 20,
    [ValidateRange(4096, 32768)][int]$MemoryInMB = 8192,
    [switch]$EnableClipboard,
    [switch]$PlanOnly,
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
}
if ([string]::IsNullOrWhiteSpace($NodeRoot)) {
    $node = Get-Command node.exe -ErrorAction Stop
    $NodeRoot = Split-Path -Parent $node.Source
}
if ([string]::IsNullOrWhiteSpace($PostgresRoot)) {
    $candidates = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction Stop |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\initdb.exe') } |
        Sort-Object { [int]$_.Name } -Descending
    if (-not $candidates) { throw 'A local PostgreSQL installation was not found.' }
    $PostgresRoot = $candidates[0].FullName
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $RepositoryRoot ('.run\workbench-test-lab\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
}
if ($ReleaseVersion -notmatch '^\d+\.\d+\.\d+(?:-rc\.\d+)?$') { throw 'ReleaseVersion is invalid.' }
if ($ReleaseSha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'ReleaseSha256 must be a SHA-256 digest.' }
$archiveName = "FORGE-Workbench-$ReleaseVersion-Windows-x64.zip"
$releaseUrl = "https://github.com/ProjForge/Forge/releases/download/v$ReleaseVersion/$archiveName"

$plan = [ordered]@{
    safe = $true
    mode = if ($PlanOnly) { 'plan' } else { 'interactive-lab' }
    isolation = 'Windows Sandbox'
    releaseVersion = $ReleaseVersion
    releaseUrl = $releaseUrl
    releaseSha256 = $ReleaseSha256.ToUpperInvariant()
    publicArtifactVerified = $true
    sourceReadOnly = $true
    releaseReadOnly = $true
    nodeReadOnly = $true
    postgresBinariesReadOnly = $true
    freshPostgresData = $true
    hostDatabaseTouched = $false
    networking = 'disabled-in-sandbox'
    clipboard = if ($EnableClipboard) { 'enabled' } else { 'disabled' }
    reset = 'Close Windows Sandbox'
    output = [IO.Path]::GetFullPath($OutputRoot)
}
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 5; return }

$required = [ordered]@{
    bootstrap = Join-Path $RepositoryRoot 'scripts\install-forge-windows.ps1'
    lab = Join-Path $RepositoryRoot 'scripts\acceptance\windows-sandbox\Invoke-FORGE-WorkbenchTestLab.ps1'
    dependencies = Join-Path $RepositoryRoot 'node_modules\pg\package.json'
    gatewayBuild = Join-Path $RepositoryRoot 'packages\persistence-gateway\dist\index.js'
    node = Join-Path $NodeRoot 'node.exe'
    npm = Join-Path $NodeRoot 'npm.cmd'
    postgres = Join-Path $PostgresRoot 'bin\initdb.exe'
    pgvectorControl = Join-Path $PostgresRoot 'share\extension\vector.control'
    pgvectorDll = Join-Path $PostgresRoot 'lib\vector.dll'
}
foreach ($entry in $required.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) { throw "Missing $($entry.Key) input: $($entry.Value)" }
}

$sandboxExe = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not (Test-Path -LiteralPath $sandboxExe -PathType Leaf)) {
    throw 'Windows Sandbox is not enabled. Run Enable-FORGE-WindowsSandbox.ps1 as administrator and restart Windows.'
}

$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$inputRoot = Join-Path $OutputRoot 'input'
$resultRoot = Join-Path $OutputRoot 'result'
$archivePath = Join-Path $inputRoot $archiveName
$distributionRoot = Join-Path $inputRoot 'release'
New-Item -ItemType Directory -Force -Path $inputRoot, $resultRoot | Out-Null
if (-not [string]::IsNullOrWhiteSpace($ReleaseArchive)) {
    $resolvedArchive = [IO.Path]::GetFullPath($ReleaseArchive)
    if (-not (Test-Path -LiteralPath $resolvedArchive -PathType Leaf)) { throw "Release archive was not found: $resolvedArchive" }
    Copy-Item -LiteralPath $resolvedArchive -Destination $archivePath -Force
} elseif (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    Write-Host "Downloading pinned FORGE Workbench $ReleaseVersion artifact..."
    Invoke-WebRequest -Uri $releaseUrl -OutFile $archivePath -UseBasicParsing
}
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actualHash -ne $ReleaseSha256.ToUpperInvariant()) {
    throw "Release archive SHA-256 mismatch. Expected $($ReleaseSha256.ToUpperInvariant()), received $actualHash."
}
if (Test-Path -LiteralPath $distributionRoot) { Remove-Item -LiteralPath $distributionRoot -Recurse -Force }
Expand-Archive -LiteralPath $archivePath -DestinationPath $distributionRoot
$releaseMetadata = Get-ChildItem -LiteralPath $distributionRoot -Filter RELEASE.json -File -Recurse | Select-Object -First 1
if ($null -eq $releaseMetadata) { throw 'The verified release archive does not contain RELEASE.json.' }
$release = Get-Content -Raw -LiteralPath $releaseMetadata.FullName | ConvertFrom-Json
if ($release.product -ne 'FORGE Workbench' -or $release.version -ne $ReleaseVersion -or $release.platform -ne 'windows-x64') {
    throw 'The verified release metadata does not match the requested Windows candidate.'
}
$distribution = Split-Path -Parent $releaseMetadata.FullName

function Escape-Xml([string]$Value) { return [Security.SecurityElement]::Escape([IO.Path]::GetFullPath($Value)) }
$configurationPath = Join-Path $OutputRoot 'FORGE-Workbench-Test-Lab.wsb'
$clipboard = if ($EnableClipboard) { 'Enable' } else { 'Disable' }
$configuration = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Disable</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ClipboardRedirection>$clipboard</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <MemoryInMB>$MemoryInMB</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>$(Escape-Xml $RepositoryRoot)</HostFolder><SandboxFolder>C:\FORGE\Input\Source</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $NodeRoot)</HostFolder><SandboxFolder>C:\FORGE\Input\Node</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $PostgresRoot)</HostFolder><SandboxFolder>C:\FORGE\Input\PostgreSQL</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $distribution)</HostFolder><SandboxFolder>C:\FORGE\Input\Release</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $resultRoot)</HostFolder><SandboxFolder>C:\FORGE\Output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\FORGE\Input\Source\scripts\acceptance\windows-sandbox\Invoke-FORGE-WorkbenchTestLab.ps1 -ExpectedVersion $ReleaseVersion</Command>
  </LogonCommand>
</Configuration>
"@
[IO.File]::WriteAllText($configurationPath, $configuration, [Text.UTF8Encoding]::new($false))
$process = Start-Process -FilePath $sandboxExe -ArgumentList ('"' + $configurationPath + '"') -PassThru
Write-Output "Windows Sandbox test lab started. Close its window for a complete reset. Result: $(Join-Path $resultRoot 'lab-result.json')"
if ($NoWait) { return }

$resultPath = Join-Path $resultRoot 'lab-result.json'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
        $result | ConvertTo-Json -Depth 8
        if ($result.status -ne 'READY') { throw "Windows Sandbox test lab failed: $($result.detail)" }
        return
    }
    if ($process.HasExited) { throw 'Windows Sandbox closed before the test lab became ready.' }
    Start-Sleep -Seconds 2
    $process.Refresh()
}
throw "Windows Sandbox test lab did not become ready within $TimeoutMinutes minutes."
