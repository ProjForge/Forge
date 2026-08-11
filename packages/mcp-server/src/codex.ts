#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { runForgeStdioServer } from './stdio.js'

const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const decryptScript = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security -ErrorAction Stop',
  '$root = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "FORGE"',
  '$path = Join-Path $root "forge_test_runner.dpapi"',
  'if (-not (Test-Path -LiteralPath $path)) { throw "FORGE credential is not configured." }',
  '$protected = $null',
  '$plain = $null',
  'try {',
  '  $text = (Get-Content -Raw -LiteralPath $path).Trim()',
  '  $protected = [Convert]::FromBase64String($text)',
  '  $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
  '} finally {',
  '  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }',
  '  if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }',
  '}',
].join('; ')

function decryptRuntimePassword(): Buffer {
  const encodedCommand = Buffer.from(decryptScript, 'utf16le').toString('base64')
  const result = spawnSync(
    windowsPowerShell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (result.error || result.status !== 0 || result.stdout.length === 0) {
    result.stdout.fill(0)
    result.stderr.fill(0)
    throw new Error('The encrypted FORGE runtime credential could not be decrypted')
  }
  result.stderr.fill(0)
  return result.stdout
}

let passwordBuffer: Buffer | undefined
let password: string | undefined
let connectionString: string | undefined

try {
  passwordBuffer = decryptRuntimePassword()
  password = passwordBuffer.toString('utf8')
  connectionString = 'postgresql://forge_test_runner:'
    + encodeURIComponent(password)
    + '@127.0.0.1:5432/forge_test'
  await runForgeStdioServer(connectionString)
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown launcher error'
  console.error('FORGE MCP Codex launcher failed: ' + message)
  process.exitCode = 1
} finally {
  passwordBuffer?.fill(0)
  passwordBuffer = undefined
  password = undefined
  connectionString = undefined
}
