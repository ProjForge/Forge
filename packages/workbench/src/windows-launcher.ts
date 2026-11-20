#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorkbenchConfig } from './config.js'
import { runWorkbench } from './main.js'
import { loadWindowsConfig, parseWindowsConfig, recoveryHealthEnvironment, runtimeEnvironment } from './windows-config.js'

import { probeExit, probeWindowsDatabase } from './windows-probe.js'

const powerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const decryptScript = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security -ErrorAction Stop',
  '$path = $env:FORGE_DPAPI_PATH',
  'if (-not (Test-Path -LiteralPath $path)) { throw "FORGE credential is not configured." }',
  '$protected = $null', '$plain = $null',
  'try {',
  ' $protected = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $path).Trim())',
  ' $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  ' [Console]::OpenStandardOutput().Write($plain, 0, $plain.Length)',
  '} finally {',
  ' if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }',
  ' if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }',
  '}',
].join('; ')

function decryptPassword(path: string): Buffer {
  const result = spawnSync(powerShell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(decryptScript, 'utf16le').toString('base64'),
  ], {
    encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORGE_DPAPI_PATH: path },
  })
  if (result.error || result.status !== 0 || result.stdout.length === 0) {
    result.stdout?.fill(0); result.stderr?.fill(0)
    throw new Error('The encrypted FORGE runtime credential could not be decrypted')
  }
  result.stderr.fill(0)
  return result.stdout
}

async function checkDatabase(args: string[]): Promise<void> {
  let secret: Buffer | undefined
  try {
    const [mode, host, port, name, user] = args
    const database = mode === 'existing' && host && args.length === 2
      ? parseWindowsConfig(JSON.parse(readFileSync(join(host, 'workbench.json'), 'utf8').replace(/^\uFEFF/, ''))).database
      : parseWindowsConfig({ database: { host, port: Number(port), name, user } }).database
    if (mode === 'existing' && host && args.length === 2) {
      if (!/^[^\\/:*?"<>|]+$/.test(database.credentialFile) || /^[. ]+$/.test(database.credentialFile)) {
        throw new Error('Invalid credential file')
      }
      secret = decryptPassword(join(host, database.credentialFile))
    } else if (mode === 'entered' && args.length === 5) {
      secret = readFileSync(0)
    }
    process.exitCode = secret?.length
      ? await probeWindowsDatabase(database, secret.toString('utf8'))
      : probeExit.credentials
  } catch {
    process.exitCode = probeExit.configuration
  } finally {
    secret?.fill(0)
  }
}

async function main(): Promise<void> {
  let passwordBuffer: Buffer | undefined
  let password: string | undefined
  try {
    const configRoot = process.env.FORGE_CONFIG_ROOT ?? join(process.env.APPDATA ?? '', 'FORGE')
    const windowsConfig = loadWindowsConfig(configRoot)
    passwordBuffer = decryptPassword(join(configRoot, windowsConfig.database.credentialFile))
    password = passwordBuffer.toString('utf8')
    const { FORGE_DATABASE_URL: _databaseOverride, FORGE_WORKBENCH_PORT: _portOverride, ...processSettings } = process.env
    const env = runtimeEnvironment(windowsConfig, password, {
      FORGE_EMBEDDING_STATUS_FILE: join(configRoot, 'embedding-worker-status.json'),
      ...(windowsConfig.embedding.projectId ? { FORGE_PROJECT_ID: windowsConfig.embedding.projectId } : {}),
      ...recoveryHealthEnvironment(configRoot), ...processSettings,
    })
    await runWorkbench(loadWorkbenchConfig(env))
  } finally {
    passwordBuffer?.fill(0); passwordBuffer = undefined; password = undefined
  }
}

void (process.argv[2] === '--check-database' ? checkDatabase(process.argv.slice(3)) : main()).catch((error: unknown) => {
  console.error('FORGE Workbench Windows launcher failed: ' + (error instanceof Error ? error.message : 'unknown error'))
  process.exitCode = 1
})
