#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { loadSemanticBridgeConfig } from './config.js'
import { runForgeSemanticBridgeStdio } from './stdio.js'

const powerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const decryptScript = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security -ErrorAction Stop',
  '$path = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "FORGE\\forge_test_runner.dpapi"',
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

function decryptPassword(): Buffer {
  const result = spawnSync(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(decryptScript, 'utf16le').toString('base64')], {
    encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0 || result.stdout.length === 0) {
    result.stdout.fill(0); result.stderr.fill(0)
    throw new Error('The encrypted FORGE runtime credential could not be decrypted')
  }
  result.stderr.fill(0)
  return result.stdout
}

let passwordBuffer: Buffer | undefined
let password: string | undefined
try {
  passwordBuffer = decryptPassword()
  password = passwordBuffer.toString('utf8')
  const env = {
    ...process.env,
    FORGE_DATABASE_URL: `postgresql://forge_test_runner:${encodeURIComponent(password)}@127.0.0.1:5432/forge_test`,
  }
  await runForgeSemanticBridgeStdio(loadSemanticBridgeConfig(env))
} catch (error) {
  console.error('FORGE Semantic Bridge Codex launcher failed: ' + (error instanceof Error ? error.message : 'unknown error'))
  process.exitCode = 1
} finally {
  passwordBuffer?.fill(0); passwordBuffer = undefined; password = undefined
}
