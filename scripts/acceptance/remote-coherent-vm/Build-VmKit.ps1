[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodeExe,
    [Parameter(Mandatory)][string]$PostgresRoot,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [switch]$Zip
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# No installation, cluster initialization or service launch occurs here.
function Assert-NoRedirect([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected path: $($item.FullName)" }
        if ($item -is [IO.DirectoryInfo]) { $item = $item.Parent } else { $item = $item.Directory }
    }
}
function Assert-SafeTree([string]$Path) {
    Assert-NoRedirect $Path
    $pending = New-Object 'Collections.Generic.Queue[string]'
    $pending.Enqueue($Path)
    $count = 0
    while ($pending.Count) {
        $item = Get-Item -LiteralPath $pending.Dequeue() -Force
        if ((++$count) -gt 200000) { throw 'Runtime traversal limit exceeded' }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected runtime: $($item.FullName)" }
        if (!$item.PSIsContainer -and ($item.Extension -in @('.pem','.key','.pfx','.dump','.enc') -or
            $item.Name -match '^(?:\.env(?:\.|$)|\.?pgpass(?:\.conf)?$|postgresql\.conf$|pg_hba\.conf$)')) {
            throw "Unexpected key, dump or configuration file: $($item.Name)"
        }
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Enqueue($child.FullName) }
        }
    }
}
function Assert-Native([string]$Exe, [string[]]$Arguments, [string]$Expected) {
    $result = & $Exe @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -or ($result -join "`n") -cnotmatch $Expected) { throw "Unexpected runtime: $Exe" }
}

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$NodeExe = [IO.Path]::GetFullPath($NodeExe)
$PostgresRoot = [IO.Path]::GetFullPath($PostgresRoot)
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if ($output -notmatch '^[A-Za-z]:\\' -or $output -match ':.*:') { throw 'Output must be a fresh local drive path' }
$parent = Split-Path -Parent $output
Assert-NoRedirect $parent
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory must not exist' }
foreach ($artifact in @("$output.zip", "$output.zip.sha256")) {
    if ($Zip -and (Test-Path -LiteralPath $artifact)) { throw "Archive output already exists: $artifact" }
}

# Exact repository allowlist. Do not copy the workspace, evidence or npm links.
$copies = @()
foreach ($name in @('README.md','acta.md','bootstrap.ps1','sandbox-config.xml',
    'Start-Rehearsal.ps1','Submit-Replica.ps1','Start-VmDestination.ps1','Submit-VmReplica.ps1','Test-Kit.mjs')) {
    $copies += @{ Source = Join-Path $PSScriptRoot $name; Target = $name }
}
foreach ($name in @('acl.ps1','check-handoff.mjs','database.mjs','guest.ps1','probe.mjs','role.ps1')) {
    $copies += @{ Source = Join-Path $PSScriptRoot "input/$name"; Target = "input/$name" }
}
$copies += @{ Source = Join-Path $repo 'scripts/acceptance/remote-coherent-transfer.mjs'; Target = 'input/remote-coherent-transfer.mjs' }
foreach ($relative in @('coordinator/dist','coordinator/sql','coordinator/package.json',
    'resilience/dist','resilience/package.json','schema/database','schema/scripts','schema/src','schema/tests')) {
    $copies += @{ Source = Join-Path $repo "packages/$relative"; Target = "input/packages/$relative" }
}
foreach ($relative in @('dist','package.json')) {
    $copies += @{ Source = Join-Path $repo "packages/persistence-gateway/$relative"; Target = "input/node_modules/forge-persistence-gateway/$relative" }
}
$copies += @{ Source = $NodeExe; Target = 'input/node.exe' }
foreach ($name in @('bin','lib','share')) {
    $copies += @{ Source = Join-Path $PostgresRoot $name; Target = "input/postgres/$name" }
}

# Resolve only pg's installed dependency closure, including installed optional deps.
# Flattening is deliberate: conflicting installed versions fail rather than change resolution.
$dependencies = @{}
function Add-Dependency([string]$Name, [string]$From, [bool]$Optional = $false) {
    if ($Name -notmatch '^(?:@[a-z0-9._-]+/)?[a-z0-9._-]+$') { throw "Invalid dependency name: $Name" }
    $cursor = $From
    $found = $null
    while ($cursor -and ($cursor -ieq $repo -or $cursor.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase))) {
        $candidate = Join-Path $cursor "node_modules/$Name"
        if (Test-Path -LiteralPath (Join-Path $candidate 'package.json') -PathType Leaf) { $found = $candidate; break }
        $cursor = Split-Path -Parent $cursor
    }
    if (!$found) {
        if ($Optional) { return }
        throw "Missing installed dependency: $Name"
    }
    Assert-SafeTree $found
    $manifest = Get-Content -LiteralPath (Join-Path $found 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($dependencies.ContainsKey($Name)) {
        if ($dependencies[$Name].Version -ne $manifest.version) { throw "Conflicting dependency versions: $Name" }
        return
    }
    $dependencies[$Name] = @{ Source = $found; Version = $manifest.version }
    foreach ($kind in @('dependencies','optionalDependencies')) {
        $property = $manifest.PSObject.Properties[$kind]
        if ($null -ne $property) {
            foreach ($dependency in $property.Value.PSObject.Properties) {
                Add-Dependency $dependency.Name $found ($kind -eq 'optionalDependencies')
            }
        }
    }
}
Add-Dependency 'pg' $repo
foreach ($name in $dependencies.Keys) {
    $copies += @{ Source = $dependencies[$name].Source; Target = "input/node_modules/$name" }
}

# Complete all source checks before creating any destination.
foreach ($copy in $copies) {
    Assert-SafeTree $copy.Source
    $source = [IO.Path]::GetFullPath($copy.Source).TrimEnd('\')
    if ($output -ieq $source -or $output.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Output overlaps a source'
    }
}
Assert-Native $NodeExe @('-p', '[process.version,process.platform,process.arch].join(String.fromCharCode(32))') '^v22\.23\.4 win32 x64$'
foreach ($exe in @('postgres','initdb','pg_ctl','pg_dump','pg_restore','psql')) {
    Assert-Native (Join-Path $PostgresRoot "bin/$exe.exe") @('--version') '\(PostgreSQL\) 18\.4(?:\s|$)'
}
foreach ($relative in @('lib/vector.dll','share/extension/vector.control')) {
    if (!(Test-Path -LiteralPath (Join-Path $PostgresRoot $relative) -PathType Leaf)) { throw "Missing pgvector: $relative" }
}
$control = Get-Content -LiteralPath (Join-Path $PostgresRoot 'share/extension/vector.control') -Raw
if ($control -notmatch "default_version\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'") { throw 'Invalid pgvector version' }
if (!(Test-Path -LiteralPath (Join-Path $PostgresRoot "share/extension/vector--$($Matches[1]).sql") -PathType Leaf)) { throw 'Missing pgvector installation SQL' }

# A failed build is retained for diagnosis; never recursively delete operator paths.
$null = New-Item -ItemType Directory -Path $output
foreach ($copy in $copies) {
    $target = Join-Path $output $copy.Target
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force
    Copy-Item -LiteralPath $copy.Source -Destination $target -Recurse -Force
}
Assert-SafeTree $output
foreach ($script in Get-ChildItem -LiteralPath $output -Filter '*.ps1' -File -Recurse) {
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw "PowerShell parse failed: $($script.FullName)" }
}
Push-Location $output
try {
    & (Join-Path $output 'input/node.exe') 'Test-Kit.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Kit smoke test failed; archive not created' }
} finally { Pop-Location }
if ($Zip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($output, "$output.zip")
    $hash = (Get-FileHash -LiteralPath "$output.zip" -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$output.zip.sha256", "$hash  $([IO.Path]::GetFileName($output)).zip`n", (New-Object Text.UTF8Encoding($false)))
}
Write-Output "Portable kit verified: $output"
