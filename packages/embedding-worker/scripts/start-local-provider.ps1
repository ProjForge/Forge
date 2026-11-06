[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigRoot)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $ConfigRoot 'workbench.json') -Raw | ConvertFrom-Json
$endpoint = [uri]$config.embedding.baseUrl
if ($endpoint.Scheme -ne 'http' -or $endpoint.Host -ne '127.0.0.1' -or $endpoint.Port -ne 1234) { throw 'Automatic startup requires the configured loopback LM Studio endpoint on port 1234.' }
$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (-not (Test-Path -LiteralPath $lms -PathType Leaf)) { throw 'LM Studio CLI is not installed.' }
$models = & $lms ls --json
if ($LASTEXITCODE -ne 0) { throw 'LM Studio model inventory failed.' }
$inventory = ([string]($models -join "`n")) | ConvertFrom-Json
$model = @($inventory | Where-Object modelKey -eq $config.embedding.model)
if ($model.Count -ne 1 -or $model[0].type -ne 'embedding') { throw 'The configured embedding model must be installed unambiguously.' }
$loaded = & $lms ps --json
if ($LASTEXITCODE -ne 0) { throw 'LM Studio loaded model inventory failed.' }
$loadedModels = ([string]($loaded -join "`n")) | ConvertFrom-Json
if (-not @($loadedModels | Where-Object identifier -eq $config.embedding.model).Count) {
    & $lms load ([string]$model[0].modelKey) --identifier ([string]$config.embedding.model) --context-length 4096 --parallel 1 --yes | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Embedding model load failed.' }
}
& $lms server start --bind 127.0.0.1 --port 1234 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Local model server startup failed.' }
$body = @{ model=[string]$config.embedding.model; input=@('FORGE readiness'); dimensions=[int]$config.embedding.dimensions } | ConvertTo-Json
$probe = Invoke-RestMethod -Uri ($config.embedding.baseUrl.TrimEnd('/')+'/embeddings') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 60
if (@($probe.data).Count -ne 1 -or @($probe.data[0].embedding).Count -ne [int]$config.embedding.dimensions) { throw 'Embedding readiness returned incorrect dimensions.' }
foreach ($value in $probe.data[0].embedding) { if ($value -isnot [ValueType] -or [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value)) { throw 'Embedding readiness returned invalid values.' } }
Write-Output 'PASS: local embedding provider and configured dimensions verified.'
