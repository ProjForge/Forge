import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolvePostgresTool, safeConnection } from './config.js'
import { spawnPostgres } from './process.js'
import { decryptFile, encryptToFile, hashFile, newEncryptionMaterial, defaultScryptParameters } from './crypto.js'
import { canonicalJson } from './manifest.js'

export const coherentRoles = ['core', 'coordinator', 'report', 'identity'] as const
export type CoherentRole = typeof coherentRoles[number]
export type CoherentFiles = Record<CoherentRole, string>
export interface CoherentKey { keyId: string; key: Uint8Array }

/** Capture to a caller-owned new private path while its maintenance lease is held. */
export async function captureCoherentPostgresArchive(options: { connectionString: string; postgresBin: string; destination: string; role?: string }): Promise<void> {
  const connection = safeConnection(options.connectionString)
  const tool = resolvePostgresTool('pg_dump', options.postgresBin)
  // Exclusive output creation prevents accidental overwrite of a prior capture.
  const { open: openFile } = await import('node:fs/promises')
  const output = await openFile(options.destination, 'wx', 0o600)
  try {
    const postgres = spawnPostgres(tool, ['--format=custom', `--dbname=${connection.connectionArgument}`, ...(options.role ? [`--role=${options.role}`] : [])], connection.environment)
    postgres.child.stdin.end()
    const timer = setTimeout(() => postgres.child.kill(), 30_000)
    try {
      const copy = pipeline(postgres.child.stdout, output.createWriteStream()).catch((error: unknown) => { postgres.child.kill(); throw error })
      const results = await Promise.allSettled([copy, postgres.completion])
      for (const result of results) if (result.status === 'rejected') throw result.reason
    } finally { clearTimeout(timer) }
  } catch (error) {
    await output.close()
    await rm(options.destination, { force: true })
    throw error
  } finally { await output.close() }
}
interface Envelope { salt: string; iv: string; authTag: string }
interface Component { role: CoherentRole; sha256: string; bytes: number; envelope: Envelope }
interface Header { format: 'forge-coherent'; version: 1; generation: string; keyId: string }
interface Inventory { header: Header; cutoff: string; components: Component[] }

function requireKey(key: CoherentKey): void {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key.keyId) || key.key.byteLength !== 32) throw new Error('External 32-byte random key and keyId required')
}
function header(value: unknown): Header {
  const h = value as Header
  if (!h || h.format !== 'forge-coherent' || h.version !== 1 || !/^[a-f0-9-]{36}$/.test(h.generation) || !/^[a-zA-Z0-9_-]{1,100}$/.test(h.keyId)) throw new Error('Invalid coherent generation header')
  return { format: h.format, version: h.version, generation: h.generation, keyId: h.keyId }
}
function envelope(value: Envelope): Envelope {
  for (const [field, size] of [['salt', 16], ['iv', 12], ['authTag', 16]] as const) {
    if (!value || typeof value[field] !== 'string' || !new RegExp(`^[a-f0-9]{${size * 2}}$`).test(value[field])) throw new Error('Invalid coherent encryption envelope')
  }
  return value
}
async function seal(source: Readable, destination: string, key: CoherentKey, aad: unknown): Promise<Envelope> {
  const material = newEncryptionMaterial()
  const result = await encryptToFile(source, destination, key.key, material, canonicalJson(aad))
  return { salt: material.salt.toString('hex'), iv: material.iv.toString('hex'), authTag: result.authTag.toString('hex') }
}
async function open(source: string, sink: Writable, key: CoherentKey, e: Envelope, aad: unknown): Promise<void> {
  envelope(e)
  await decryptFile(source, sink, key.key, Buffer.from(e.salt, 'hex'), Buffer.from(e.iv, 'hex'), Buffer.from(e.authTag, 'hex'), defaultScryptParameters, canonicalJson(aad))
}
function collect(chunks: Buffer[], limit: number): Writable {
  let size = 0
  return new Writable({ write(chunk: Buffer, _encoding, callback) {
    size += chunk.length
    if (size > limit) callback(new Error('Coherent inventory too large'))
    else { chunks.push(Buffer.from(chunk)); callback() }
  } })
}

/** The supervisor must reject admissions and drain ALL controlled DB/effect writers.
 * assertHeld must fail if that lease is lost. SQL locks alone do not satisfy it.
 * capture must return stable private files, retained until this call returns.
 */
export async function createCoherentGeneration(options: {
  root: string; key: CoherentKey
  maintenance: { assertHeld(): Promise<void> }
  capture(): Promise<{ cutoff: string; files: CoherentFiles }>
}): Promise<{ directory: string; generation: string }> {
  requireKey(options.key)
  await options.maintenance.assertHeld()
  await mkdir(options.root, { recursive: true })
  const h: Header = { format: 'forge-coherent', version: 1, generation: randomUUID(), keyId: options.key.keyId }
  const staging = await mkdtemp(path.join(options.root, '.staging-'))
  const directory = path.join(options.root, h.generation)
  try {
    const captured = await options.capture()
    if (!Number.isFinite(Date.parse(captured.cutoff)) || canonicalJson(Object.keys(captured.files).sort()) !== canonicalJson([...coherentRoles].sort())) throw new Error('Exact coherent roles and cutoff required')
    const components: Component[] = []
    for (const role of coherentRoles) {
      const before = await hashFile(captured.files[role])
      if (before.bytes === 0) throw new Error('Empty coherent component')
      const e = await seal(createReadStream(captured.files[role]), path.join(staging, `${role}.enc`), options.key, { ...h, role })
      const after = await hashFile(captured.files[role])
      if (canonicalJson(before) !== canonicalJson(after)) throw new Error('Capture changed under maintenance lease')
      components.push({ role, ...before, envelope: e })
    }
    const inventory: Inventory = { header: h, cutoff: captured.cutoff, components }
    const e = await seal(Readable.from([canonicalJson(inventory)]), path.join(staging, 'inventory.enc'), options.key, h)
    await writeFile(path.join(staging, 'ready.json'), canonicalJson({ ...h, envelope: e }), { flag: 'wx', mode: 0o600 })
    await options.maintenance.assertHeld()
    // Authenticate our staged output before publishing. Existing generations are immutable.
    await withVerifiedCoherentGeneration({ directory: staging, generation: h.generation, key: options.key }, async () => {})
    await options.maintenance.assertHeld()
    await rename(staging, directory)
    return { directory, generation: h.generation }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/** No restore/reconciliation callback runs until every component authenticates.
 * Private materializations avoid re-reading untrusted bundle paths after validation.
 * The callback owns destination isolation; two database restores are NOT one transaction.
 */
export async function withVerifiedCoherentGeneration<T>(options: {
  directory: string; generation: string; key: CoherentKey
}, restore: (files: CoherentFiles, inventory: { generation: string; cutoff: string }) => Promise<T>): Promise<T> {
  requireKey(options.key)
  const ready = JSON.parse(await readFile(path.join(options.directory, 'ready.json'), 'utf8')) as Header & { envelope: Envelope }
  const h = header(ready)
  if (h.generation !== options.generation || h.keyId !== options.key.keyId) throw new Error('Unexpected generation or keyId')
  const chunks: Buffer[] = []
  await open(path.join(options.directory, 'inventory.enc'), collect(chunks, 64 * 1024), options.key, ready.envelope, h)
  const inventory = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Inventory
  if (canonicalJson(inventory.header) !== canonicalJson(h) || !Number.isFinite(Date.parse(inventory.cutoff)) || !Array.isArray(inventory.components) || canonicalJson(inventory.components.map(c => c.role).sort()) !== canonicalJson([...coherentRoles].sort())) throw new Error('Invalid coherent inventory')
  const scratch = await mkdtemp(path.join(tmpdir(), 'forge-verified-'))
  const files = {} as CoherentFiles
  try {
    for (const component of inventory.components) {
      const { role } = component
      if (!/^[a-f0-9]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.bytes) || component.bytes <= 0) throw new Error('Invalid component digest')
      files[role] = path.join(scratch, role)
      // Partial plaintext is confined to scratch and removed on authentication failure.
      await open(path.join(options.directory, `${role}.enc`), createWriteStream(files[role], { flags: 'wx', mode: 0o600 }), options.key, component.envelope, { ...h, role })
      const actual = await hashFile(files[role])
      if (actual.sha256 !== component.sha256 || actual.bytes !== component.bytes) throw new Error('Coherent component digest mismatch')
    }
    return await restore(files, { generation: h.generation, cutoff: inventory.cutoff })
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
