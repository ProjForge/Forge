$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE\forge_test_runner.dpapi'
if (-not (Test-Path -LiteralPath $credentialPath)) { throw "DPAPI credential not found: $credentialPath" }
$projectPath = Split-Path -Parent $PSScriptRoot

try {
    Push-Location -LiteralPath $projectPath
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $protected = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $credentialPath).Trim())
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
    $encodedPassword = [Uri]::EscapeDataString($password)
    $env:FORGE_DATABASE_URL = "postgresql://forge_test_runner:$encodedPassword@127.0.0.1:5432/forge_test"
    $env:FORGE_EMBEDDING_BASE_URL = 'http://127.0.0.1:1234/v1'
    $env:FORGE_EMBEDDING_MODEL = 'text-embedding-qwen3-embedding-0.6b'
    $env:FORGE_EMBEDDING_PROFILE_KEY = 'qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1'
    $env:FORGE_EMBEDDING_DIMENSIONS = '1024'
    $env:FORGE_EMBEDDING_QUERY_PREFIX = "Instruct: Given a user question about a software project, retrieve the most relevant project decision or memory that answers the question`nQuery:"
    $env:FORGE_RERANKER_MODEL = 'forge-reranker-qwen35-9b'
    $env:FORGE_PROJECT_ID = 'bd726f08-4ccd-41c4-a861-8b7c5e7aec33'
    $env:FORGE_EMBEDDING_QUERY = '¿Qué modelo local de embeddings multilingüe recomendamos para FORGE y por qué?'
    npm run smoke:live
} finally {
    Pop-Location
    $password = $null
    $passwordBytes = $null
    Remove-Item Env:FORGE_DATABASE_URL, Env:FORGE_EMBEDDING_BASE_URL, Env:FORGE_EMBEDDING_MODEL, Env:FORGE_EMBEDDING_PROFILE_KEY, Env:FORGE_EMBEDDING_DIMENSIONS, Env:FORGE_EMBEDDING_QUERY_PREFIX, Env:FORGE_RERANKER_MODEL, Env:FORGE_PROJECT_ID, Env:FORGE_EMBEDDING_QUERY -ErrorAction SilentlyContinue
}
