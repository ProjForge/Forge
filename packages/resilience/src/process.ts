import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_STDERR = 64 * 1024

export async function commandVersion(executable: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(executable, ['--version'], {
    env: environment,
    windowsHide: true,
    maxBuffer: MAX_STDERR,
  })
  return stdout.trim()
}

export function spawnPostgres(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; completion: Promise<void>; stderr: () => string } {
  const child = spawn(executable, [...args], {
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let captured = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    captured = `${captured}${chunk}`.slice(-MAX_STDERR)
  })

  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`PostgreSQL tool failed (${code ?? signal ?? 'unknown'}): ${captured.trim() || 'no diagnostics'}`))
    })
  })
  return { child, completion, stderr: () => captured }
}

export function childInput(child: ChildProcessWithoutNullStreams): Writable {
  return child.stdin
}
