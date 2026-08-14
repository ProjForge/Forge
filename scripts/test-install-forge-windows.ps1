[CmdletBinding()]
param()

$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$root=Join-Path ([IO.Path]::GetTempPath()) ('forge-bootstrap-test-'+[Guid]::NewGuid().ToString('N'))
try{
    $json=& (Join-Path $PSScriptRoot 'install-forge-windows.ps1') -ConfigRoot $root -DatabaseName forge_generic -RuntimeUser forge_runtime -ConfigureEmbedding -ProjectId '11111111-2222-4333-8444-555555555555' -RegisterCodexMcp -SkipWorkbench -PlanOnly
    $plan=$json|ConvertFrom-Json
    if(-not $plan.safe -or $plan.mode -ne 'plan'){throw 'Bootstrap did not produce a safe plan.'}
    foreach($phase in @('preflight','database','runtime-config','codex-mcp','embedding-worker')){if($phase -notin $plan.phases){throw "Missing phase: $phase"}}
    if(Test-Path -LiteralPath $root){throw 'Plan mode changed the filesystem.'}
    $rollbackJson=& (Join-Path $PSScriptRoot 'install-forge-windows.ps1') -ConfigRoot $root -Rollback -PlanOnly
    if(($rollbackJson|ConvertFrom-Json).mode -ne 'rollback'){throw 'Rollback plan was not represented safely.'}
    New-Item -ItemType Directory -Path $root | Out-Null
    '{"configurationHash":"different","completed":["database"]}' | Set-Content -LiteralPath (Join-Path $root 'bootstrap-status.json') -Encoding ascii
    $mismatchRejected=$false
    try{& (Join-Path $PSScriptRoot 'install-forge-windows.ps1') -ConfigRoot $root -SkipWorkbench -SkipBuild -Resume}catch{$mismatchRejected=$_.Exception.Message -match 'do not match'}
    if(-not $mismatchRejected){throw 'Resume accepted a different deployment configuration.'}
    $source=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'install-forge-windows.ps1')
    if($source -match 'bd726f08|941408Amm'){throw 'Bootstrap contains a deployment-specific identifier or secret.'}
    Write-Output 'PASS: Windows bootstrap plan is generic and non-mutating.'
}finally{Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}
