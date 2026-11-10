import { constants, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { coherentRoles, withVerifiedCoherentGeneration, type CoherentKey } from './coherent.js'

/** Private escrow key belongs to a separate trusted custodian, never the bundle. */
export async function createWrappedCoherentKey(file: string, keyId: string, publicKey: string): Promise<CoherentKey> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(keyId)) throw new Error('Invalid custody key ID')
  const key = randomBytes(32)
  try {
    const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(keyId) }, key)
    await writeFile(file, JSON.stringify({ version: 1, keyId, wrapped: wrapped.toString('base64') }), { flag: 'wx', mode: 0o600 })
    return { keyId, key }
  } catch (error) { key.fill(0); throw error }
}

export async function readWrappedCoherentKey(file: string, keyId: string, privateKey: string): Promise<CoherentKey> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error('Invalid custody file')
  const record = JSON.parse(await readFile(file, 'utf8')) as { version: number; keyId: string; wrapped: string }
  if (record.version !== 1 || record.keyId !== keyId || typeof record.wrapped !== 'string') throw new Error('Unexpected custody key')
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(keyId) }, Buffer.from(record.wrapped, 'base64'))
  if (key.length !== 32) { key.fill(0); throw new Error('Invalid custody key size') }
  return { keyId, key }
}

/** Publish only a completely authenticated copy on a distinct local device. */
export async function replicateCoherentGeneration(options: { directory: string; generation: string; root: string; key: CoherentKey }): Promise<{ directory: string; sourceDevice: string; replicaDevice: string }> {
  const source = await lstat(options.directory, { bigint: true })
  const destination = await lstat(options.root, { bigint: true })
  if (!source.isDirectory() || source.isSymbolicLink() || !destination.isDirectory() || destination.isSymbolicLink() || source.dev === destination.dev) throw new Error('Replica requires distinct real filesystem devices')
  const names = [...coherentRoles.map(role => `${role}.enc`), 'inventory.enc', 'ready.json'].sort()
  if (JSON.stringify((await readdir(options.directory)).sort()) !== JSON.stringify(names)) throw new Error('Unexpected replica inventory')
  for (const name of names) {
    const info = await lstat(path.join(options.directory, name))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Replica input must be regular files')
  }
  await withVerifiedCoherentGeneration(options, async () => {})
  const staging = await mkdtemp(path.join(options.root, '.replica-'))
  try {
    for (const name of names) await cp(path.join(options.directory, name), path.join(staging, name), { errorOnExist: true, force: false })
    if ((await stat(staging, { bigint: true })).dev !== destination.dev) throw new Error('Replica device changed')
    await withVerifiedCoherentGeneration({ ...options, directory: staging }, async () => {})
    const directory = path.join(options.root, options.generation)
    // Exclusive reservation prevents replacing any preexisting final generation.
    await mkdir(directory)
    try { await rename(staging, path.join(directory, 'bundle')) }
    catch (error) { await rm(directory); throw error }
    return { directory: path.join(directory, 'bundle'), sourceDevice: source.dev.toString(), replicaDevice: destination.dev.toString() }
  } finally { await rm(staging, { recursive: true, force: true }) }
}
