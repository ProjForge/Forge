#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { loadWorkbenchConfig } from './config.js'
import { runWorkbench } from './main.js'
import { loadWindowsConfig, recoveryHealthEnvironment, runtimeEnvironment } from './windows-config.js'

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
  ' [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
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
    result.stdout.fill(0); result.stderr.fill(0)
    throw new Error('The encrypted FORGE runtime credential could not be decrypted')
  }
  result.stderr.fill(0)
  return result.stdout
}

async function main(): Promise<void> {
  let passwordBuffer: Buffer | undefined
  let password: string | undefined
  try {
    const configRoot = process.env.FORGE_CONFIG_ROOT ?? join(process.env.APPDATA ?? '', 'FORGE')
    const windowsConfig = loadWindowsConfig(configRoot)
    passwordBuffer = decryptPassword(join(configRoot, windowsConfig.database.credentialFile))
    password = passwordBuffer.toString('utf8')
    const env = runtimeEnvironment(windowsConfig, password, { ...recoveryHealthEnvironment(configRoot), ...process.env })
    await runWorkbench(loadWorkbenchConfig(env))
  } finally {
    passwordBuffer?.fill(0); passwordBuffer = undefined; password = undefined
  }
}

void main().catch((error: unknown) => {
  console.error('FORGE Workbench Windows launcher failed: ' + (error instanceof Error ? error.message : 'unknown error'))
  process.exitCode = 1
})
