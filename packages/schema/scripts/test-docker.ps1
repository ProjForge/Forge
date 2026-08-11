$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker is required for the PostgreSQL 14 container test but was not found in PATH.'
    }

    docker compose up -d --wait postgres

    $env:FORGE_TEST_DATABASE_URL = 'postgresql://forge_test:forge_test_local_only@127.0.0.1:55432/forge_test'
    $env:FORGE_TEST_RESET = '1'
    node tests/schema.test.mjs --server-before-restart

    docker compose restart postgres
    docker compose up -d --wait postgres

    Remove-Item Env:FORGE_TEST_RESET -ErrorAction SilentlyContinue
    node tests/schema.test.mjs --server-after-restart
}
finally {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        docker compose down
    }
    Pop-Location
}
