[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [string]$NodeRoot,
    [string]$PostgresRoot,
    [string]$OutputRoot,
    [ValidateRange(5, 120)][int]$TimeoutMinutes = 45,
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
    $OutputRoot = Join-Path $RepositoryRoot ('.run\windows-sandbox\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
}

$plan = [ordered]@{
    safe = $true
    mode = if ($PlanOnly) { 'plan' } else { 'acceptance' }
    isolation = 'Windows Sandbox'
    sourceReadOnly = $true
    nodeReadOnly = $true
    postgresBinariesReadOnly = $true
    freshPostgresData = $true
    hostDatabaseTouched = $false
    output = [IO.Path]::GetFullPath($OutputRoot)
    timeoutMinutes = $TimeoutMinutes
}
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 5; return }

$required = [ordered]@{
    source = Join-Path $RepositoryRoot 'scripts\install-forge-windows.ps1'
    acceptance = Join-Path $RepositoryRoot 'scripts\acceptance\windows-sandbox\Invoke-FORGE-Acceptance.ps1'
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

function Escape-Xml([string]$Value) { return [Security.SecurityElement]::Escape([IO.Path]::GetFullPath($Value)) }
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$configurationPath = Join-Path $OutputRoot 'FORGE-Acceptance.wsb'
$configuration = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Enable</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <MemoryInMB>8192</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>$(Escape-Xml $RepositoryRoot)</HostFolder><SandboxFolder>C:\FORGE\Input\Source</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $NodeRoot)</HostFolder><SandboxFolder>C:\FORGE\Input\Node</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $PostgresRoot)</HostFolder><SandboxFolder>C:\FORGE\Input\PostgreSQL</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Escape-Xml $OutputRoot)</HostFolder><SandboxFolder>C:\FORGE\Output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\FORGE\Input\Source\scripts\acceptance\windows-sandbox\Invoke-FORGE-Acceptance.ps1</Command>
  </LogonCommand>
</Configuration>
"@
[IO.File]::WriteAllText($configurationPath, $configuration, [Text.UTF8Encoding]::new($false))
$process = Start-Process -FilePath $sandboxExe -ArgumentList ('"' + $configurationPath + '"') -PassThru
Write-Output "Windows Sandbox started. Sanitized result: $(Join-Path $OutputRoot 'acceptance-result.json')"
if ($NoWait) { return }

$resultPath = Join-Path $OutputRoot 'acceptance-result.json'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
        $result | ConvertTo-Json -Depth 8
        if ($result.status -ne 'PASS') { throw "Windows Sandbox acceptance failed: $($result.detail)" }
        return
    }
    if ($process.HasExited) { throw 'Windows Sandbox closed before publishing an acceptance result.' }
    Start-Sleep -Seconds 2
    $process.Refresh()
}
throw "Windows Sandbox did not finish within $TimeoutMinutes minutes."
