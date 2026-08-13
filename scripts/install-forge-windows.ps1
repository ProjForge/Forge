[CmdletBinding()]
param(
    [string]$DatabaseHost = '127.0.0.1',
    [ValidateRange(1,65535)][int]$DatabasePort = 5432,
    [ValidatePattern('^[a-z_][a-z0-9_]{0,62}$')][string]$DatabaseName = 'forge',
    [ValidatePattern('^[a-z_][a-z0-9_]{0,62}$')][string]$AdminUser = 'postgres',
    [ValidatePattern('^[a-z_][a-z0-9_]{0,62}$')][string]$RuntimeUser = 'forge_runtime',
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [ValidateRange(1,65535)][int]$WorkbenchPort = 7334,
    [Security.SecureString]$AdminPassword,
    [Security.SecureString]$RuntimePassword,
    [switch]$RegisterCodexMcp,
    [switch]$ConfigureEmbedding,
    [Guid]$ProjectId,
    [switch]$ConfigureLogicalRecovery,
    [string]$RecoveryOutputDirectory,
    [string]$RecoveryReplicaDirectory,
    [string]$PostgresBin,
    [switch]$SkipWorkbench,
    [switch]$SkipBuild,
    [switch]$Resume,
    [switch]$Rollback,
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$statusPath = Join-Path $ConfigRoot 'bootstrap-status.json'
$credentialFile = 'forge-runtime.dpapi'
$phases = @('preflight','dependencies','build','database','runtime-config')
if ($RegisterCodexMcp) { $phases += 'codex-mcp' }
if ($ConfigureEmbedding) { $phases += 'embedding-worker' }
if (-not $SkipWorkbench) { $phases += 'workbench' }
if ($ConfigureLogicalRecovery) { $phases += 'logical-recovery' }
$configurationText = @($DatabaseHost,$DatabasePort,$DatabaseName,$AdminUser,$RuntimeUser,$WorkbenchPort,$RegisterCodexMcp.IsPresent,$ConfigureEmbedding.IsPresent,$ProjectId,$ConfigureLogicalRecovery.IsPresent,$SkipWorkbench.IsPresent) -join '|'
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $configurationHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($configurationText))).Replace('-','').ToLowerInvariant() }
finally { $hashAlgorithm.Dispose() }

function Resolve-Tool([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}
function Assert-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE." } }
function Convert-Secret([Security.SecureString]$Secret) {
    $pointer = [IntPtr]::Zero
    try { $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret); return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) } }
}
function New-DatabaseUrl([string]$User,[string]$Password,[string]$Database) {
    $hostPart = if ($DatabaseHost.Contains(':') -and -not $DatabaseHost.StartsWith('[')) { "[$DatabaseHost]" } else { $DatabaseHost }
    return 'postgresql://{0}:{1}@{2}:{3}/{4}' -f [Uri]::EscapeDataString($User),[Uri]::EscapeDataString($Password),$hostPart,$DatabasePort,[Uri]::EscapeDataString($Database)
}
function Write-Status([string]$Status,[string]$Phase,[string[]]$Completed,[string]$Detail) {
    New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
    $temporary = "$statusPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $safeDetail = ($Detail -replace 'postgresql://[^:@/\s]+:[^@/\s]+@','postgresql://***:***@')
        if ($safeDetail.Length -gt 512) { $safeDetail = $safeDetail.Substring(0,512) }
        [ordered]@{version=1;configurationHash=$configurationHash;status=$Status;phase=$Phase;completed=$Completed;detail=$safeDetail;updatedAt=[DateTime]::UtcNow.ToString('o')} |
            ConvertTo-Json -Depth 5 | ForEach-Object { [IO.File]::WriteAllText($temporary,$_,[Text.UTF8Encoding]::new($false)) }
        Move-Item -LiteralPath $temporary -Destination $statusPath -Force
    } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
function Write-Dpapi([Security.SecureString]$Secret,[string]$Path) {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $pointer=[IntPtr]::Zero; $plainBytes=$null; $protectedBytes=$null
    try {
        $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
        $plainBytes=[Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
        $protectedBytes=[Security.Cryptography.ProtectedData]::Protect($plainBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllText($Path,[Convert]::ToBase64String($protectedBytes),[Text.Encoding]::ASCII)
    } finally {
        if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
        if($plainBytes){[Array]::Clear($plainBytes,0,$plainBytes.Length)}
        if($protectedBytes){[Array]::Clear($protectedBytes,0,$protectedBytes.Length)}
    }
}

$node = Resolve-Tool 'node.exe'
$npm = Resolve-Tool 'npm.cmd'
$codex = Resolve-Tool 'codex.exe'
$plan = [ordered]@{
    safe=$true; mode=if($Rollback){'rollback'}elseif($PlanOnly){'plan'}elseif($Resume){'resume'}else{'install'}
    repository=$repositoryRoot; configRoot=[IO.Path]::GetFullPath($ConfigRoot)
    database=[ordered]@{host=$DatabaseHost;port=$DatabasePort;name=$DatabaseName;admin=$AdminUser;runtime=$RuntimeUser}
    tools=[ordered]@{node=if($node){'available'}else{'missing'};npm=if($npm){'available'}else{'missing'};codex=if($codex){'available'}else{'optional-missing'}}
    phases=$phases
}
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 6; return }
if ($env:OS -ne 'Windows_NT') { throw 'This bootstrap supports Windows only.' }
if ($Rollback) {
    if ($codex) { & $codex mcp remove forge 2>$null }
    if (Get-ScheduledTask -TaskName 'FORGE Embedding Worker' -ErrorAction SilentlyContinue) {
        & (Join-Path $repositoryRoot 'packages/embedding-worker/scripts/register-windows-task.ps1') -Unregister
    }
    $uninstaller = Join-Path $env:LOCALAPPDATA 'Programs\FORGE Workbench\Uninstall-FORGE-Workbench.ps1'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) { & $uninstaller }
    Write-Status 'ROLLED_BACK' 'rollback' @() 'Clients and scheduled embedding were removed. Database, recovery and user configuration were preserved.'
    Write-Host 'FORGE client rollback completed; durable data and recovery material were preserved.' -ForegroundColor Yellow
    return
}
if (-not $node -or -not $npm) { throw 'Node.js 20+ and npm 10+ are required.' }
if ($RegisterCodexMcp -and -not $codex) { throw 'Codex CLI is required when -RegisterCodexMcp is selected.' }
if ($ConfigureEmbedding -and $ProjectId -eq [Guid]::Empty) { throw '-ProjectId is required when embedding is enabled.' }
if ($ConfigureLogicalRecovery -and ([string]::IsNullOrWhiteSpace($RecoveryOutputDirectory) -or [string]::IsNullOrWhiteSpace($RecoveryReplicaDirectory) -or [string]::IsNullOrWhiteSpace($PostgresBin))) {
    throw 'Logical recovery requires absolute output, replica and PostgreSQL bin paths.'
}

$completed = [Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $statusPath) {
    if (-not $Resume) { throw "A bootstrap state already exists. Use -Resume after reviewing $statusPath." }
    $previous = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
    if ($previous.configurationHash -ne $configurationHash) { throw 'Resume parameters do not match the original bootstrap configuration.' }
    foreach ($phase in @($previous.completed)) { $completed.Add([string]$phase) }
}
function Invoke-Phase([string]$Name,[scriptblock]$Action) {
    if ($completed.Contains($Name)) { Write-Host "SKIP $Name (already complete)"; return }
    Write-Status 'RUNNING' $Name $completed.ToArray() "Running $Name."
    try { & $Action; $completed.Add($Name); Write-Status 'RUNNING' $Name $completed.ToArray() "$Name completed." }
    catch { Write-Status 'FAIL' $Name $completed.ToArray() $_.Exception.Message; throw }
}

$adminPlain=$null; $runtimePlain=$null
try {
    Invoke-Phase 'preflight' { if(([version](& $node --version).TrimStart('v')).Major -lt 20){throw 'Node.js 20 or newer is required.'} }
    Invoke-Phase 'dependencies' { if(-not $SkipBuild){Push-Location $repositoryRoot;try{& $npm ci;Assert-Exit 'Dependency installation'}finally{Pop-Location}} }
    Invoke-Phase 'build' { if(-not $SkipBuild){Push-Location $repositoryRoot;try{& $npm run build;Assert-Exit 'FORGE build'}finally{Pop-Location}} }
    $needsAdmin = -not $completed.Contains('database') -or ($ConfigureLogicalRecovery -and -not $completed.Contains('logical-recovery'))
    $needsRuntime = -not $completed.Contains('database') -or -not $completed.Contains('runtime-config') -or ((-not $SkipWorkbench) -and -not $completed.Contains('workbench'))
    if($needsAdmin){if(-not $AdminPassword){$AdminPassword=Read-Host "Password for PostgreSQL administrator '$AdminUser'" -AsSecureString};$adminPlain=Convert-Secret $AdminPassword}
    if($needsRuntime){if(-not $RuntimePassword){$RuntimePassword=Read-Host "New password for FORGE runtime role '$RuntimeUser' (12+ characters)" -AsSecureString};$runtimePlain=Convert-Secret $RuntimePassword;if($runtimePlain.Length -lt 12){throw 'The runtime password must contain at least 12 characters.'}}
    Invoke-Phase 'database' {
        $env:FORGE_ADMIN_DATABASE_URL=New-DatabaseUrl $AdminUser $adminPlain 'postgres'
        & $node (Join-Path $repositoryRoot 'packages/schema/scripts/ensure-database.mjs') "--name=$DatabaseName"; Assert-Exit 'Database creation'
        $env:FORGE_ADMIN_DATABASE_URL=New-DatabaseUrl $AdminUser $adminPlain $DatabaseName
        $env:FORGE_DATABASE_URL=$env:FORGE_ADMIN_DATABASE_URL
        & $node (Join-Path $repositoryRoot 'packages/schema/scripts/migrate.mjs'); Assert-Exit 'Schema migration'
        $env:FORGE_RUNTIME_PASSWORD=$runtimePlain
        & $node (Join-Path $repositoryRoot 'packages/schema/scripts/configure-runtime-role.mjs') "--role=$RuntimeUser"; Assert-Exit 'Runtime role configuration'
        $env:FORGE_DATABASE_URL=New-DatabaseUrl $RuntimeUser $runtimePlain $DatabaseName
        $env:FORGE_EXPECTED_RUNTIME_ROLE=$RuntimeUser
        Push-Location $repositoryRoot
        try { & $npm run test:runtime-role -w forge-postgresql-schema; Assert-Exit 'Runtime role permission validation' }
        finally { Pop-Location; Remove-Item Env:FORGE_EXPECTED_RUNTIME_ROLE -ErrorAction SilentlyContinue }
    }
    Invoke-Phase 'runtime-config' {
        New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
        $embedding=[ordered]@{baseUrl='http://127.0.0.1:1234/v1';providerName='lmstudio-local';model='text-embedding-qwen3-embedding-0.6b';profileKey='qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1';dimensions=1024;queryPrefix="Instruct: Given a user question about a software project, retrieve the most relevant project decision or memory that answers the question`nQuery:";rerankerModel='forge-reranker-qwen35-9b'}
        if($ConfigureEmbedding){$embedding['projectId']=$ProjectId.ToString()}
        $config=[ordered]@{version=1;database=[ordered]@{host=$DatabaseHost;port=$DatabasePort;name=$DatabaseName;user=$RuntimeUser;credentialFile=$credentialFile};workbench=[ordered]@{port=$WorkbenchPort};embedding=$embedding}
        [IO.File]::WriteAllText((Join-Path $ConfigRoot 'workbench.json'),($config|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
        Write-Dpapi $RuntimePassword (Join-Path $ConfigRoot $credentialFile)
    }
    if($RegisterCodexMcp){Invoke-Phase 'codex-mcp' {
        & $codex mcp remove forge 2>$null
        & $codex mcp add forge -- $node (Join-Path $repositoryRoot 'packages/mcp-server/dist/codex.js');Assert-Exit 'Codex MCP registration'
    }}
    if($ConfigureEmbedding){Invoke-Phase 'embedding-worker' { & (Join-Path $repositoryRoot 'packages/embedding-worker/scripts/register-windows-task.ps1');Assert-Exit 'Embedding worker task registration' }}
    if(-not $SkipWorkbench){Invoke-Phase 'workbench' {
        $output=Join-Path ([IO.Path]::GetTempPath()) 'forge-workbench-bootstrap'
        & (Join-Path $repositoryRoot 'packages/workbench/packaging/windows/Build-Windows-Package.ps1') -OutputRoot $output
        $installer=Get-ChildItem -LiteralPath $output -Filter 'Install-FORGE-Workbench.ps1' -File -Recurse | Select-Object -First 1
        if(-not $installer){throw 'Workbench installer was not produced.'}
        & $installer.FullName -ConfigRoot $ConfigRoot -DatabaseHost $DatabaseHost -DatabasePort $DatabasePort -DatabaseName $DatabaseName -DatabaseUser $RuntimeUser -CredentialFile $credentialFile -WorkbenchPort $WorkbenchPort -DatabasePassword $RuntimePassword -NoLaunch
    }}
    if($ConfigureLogicalRecovery){Invoke-Phase 'logical-recovery' {
        & (Join-Path $repositoryRoot 'packages/resilience/scripts/setup-backup-role.ps1') -HostName $DatabaseHost -Port $DatabasePort -Database $DatabaseName -AdminRole $AdminUser -PostgresBin $PostgresBin -AdminPassword $AdminPassword
        & (Join-Path $repositoryRoot 'packages/resilience/scripts/install-windows-schedule.ps1') -HostName $DatabaseHost -Port $DatabasePort -Database $DatabaseName -OutputDirectory $RecoveryOutputDirectory -ReplicaDirectory $RecoveryReplicaDirectory -PostgresBin $PostgresBin -ConfigRoot $ConfigRoot
    }}
    Write-Status 'PASS' 'complete' $completed.ToArray() 'FORGE Windows bootstrap completed.'
    Write-Host 'PASS: FORGE is installed and configured.' -ForegroundColor Green
} finally {
    Remove-Item Env:FORGE_ADMIN_DATABASE_URL,Env:FORGE_DATABASE_URL,Env:FORGE_RUNTIME_PASSWORD,Env:FORGE_EXPECTED_RUNTIME_ROLE -ErrorAction SilentlyContinue
    $adminPlain=$null;$runtimePlain=$null;$AdminPassword=$null;$RuntimePassword=$null
}
