import { createHash } from 'node:crypto'
import { lstat, open, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sha256 = /^[0-9a-f]{64}$/
const components = ['core.enc', 'coordinator.enc', 'report.enc', 'identity.enc', 'inventory.enc', 'ready.json']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function requirePattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`)
}
function identity(runId, recipientSha256) {
  requirePattern(runId, uuid, 'runId')
  requirePattern(recipientSha256, sha256, 'recipientSha256')
}
async function regular(file, directory = false) {
  const info = await lstat(file)
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) throw new Error(`Not a regular ${directory ? 'directory' : 'file'}: ${file}`)
  return info
}
async function exact(directory, names) {
  await regular(directory, true)
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...names].sort())) throw new Error(`Unexpected transfer entries: ${directory}`)
}
async function layout(directory, generation, verifying) {
  // Check ancestors too: a junction in the supplied path must not bypass inventory checks.
  let ancestor = path.resolve(directory)
  for (;;) {
    await regular(ancestor, true)
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  await exact(directory, ['wrapped.json', 'bundles', ...(verifying ? ['manifest.json'] : [])])
  await exact(path.join(directory, 'bundles'), [generation])
  await exact(path.join(directory, 'bundles', generation), components)
  return ['wrapped.json', ...components.map(name => `bundles/${generation}/${name}`)].sort()
}
async function record(directory, name) {
  const file = path.join(directory, name)
  await regular(file)
  const handle = await open(file, 'r')
  try {
    const before = await handle.stat()
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length }
    const after = await handle.stat()
    if (!before.isFile() || bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Transfer file changed while hashing')
    return { path: name, bytes, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}
async function metadataBytes(file) {
  const info = await regular(file)
  if (info.size > 64 * 1024) throw new Error('Transfer metadata too large')
  return readFile(file)
}
async function checkIdentity(directory, runId, generation) {
  const wrapped = JSON.parse(await metadataBytes(path.join(directory, 'wrapped.json')))
  const ready = JSON.parse(await metadataBytes(path.join(directory, 'bundles', generation, 'ready.json')))
  if (!wrapped || wrapped.version !== 1 || wrapped.keyId !== runId || typeof wrapped.wrapped !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wrapped.wrapped) || wrapped.wrapped.length === 0) throw new Error('Unexpected custody envelope')
  if (!ready || ready.format !== 'forge-coherent' || ready.version !== 1 || ready.generation !== generation || ready.keyId !== runId) throw new Error('Unexpected coherent identity')
  for (const [name, size] of [['salt', 32], ['iv', 24], ['authTag', 32]]) {
    requirePattern(ready.envelope?.[name], new RegExp(`^[0-9a-f]{${size}}$`), `ready envelope ${name}`)
  }
}

/** Caller owns an immutable private staging directory. Publish the manifest last.
 * recipientSha256 is the caller's pinned public-key fingerprint; no keys are read.
 */
export async function writeTransferManifest(directory, { runId, generation, recipientSha256 }) {
  identity(runId, recipientSha256)
  requirePattern(generation, uuid, 'generation')
  const names = await layout(directory, generation, false)
  await checkIdentity(directory, runId, generation)
  const files = []
  for (const name of names) files.push(await record(directory, name))
  await layout(directory, generation, false)
  const manifest = { format: 'forge-coherent-transfer', version: 1, runId, generation, recipientSha256, files }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(directory, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 })
  return { generation, manifestSha256: digest(bytes) }
}

/** Must complete before provisioning/restoring. This integrity gate does not replace
 * withVerifiedCoherentGeneration or protect paths mutated after verification.
 */
export async function verifyTransferManifest(directory, { runId, recipientSha256, manifestSha256 }) {
  identity(runId, recipientSha256)
  requirePattern(manifestSha256, sha256, 'manifestSha256')
  // Reject linked roots/ancestors before opening any metadata.
  let ancestor = path.resolve(directory)
  for (;;) {
    await regular(ancestor, true)
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const file = path.join(directory, 'manifest.json')
  const bytes = await metadataBytes(file)
  if (digest(bytes) !== manifestSha256) throw new Error('Pinned manifest digest mismatch')
  const manifest = JSON.parse(bytes)
  if (!manifest || manifest.format !== 'forge-coherent-transfer' || manifest.version !== 1 || manifest.runId !== runId || manifest.recipientSha256 !== recipientSha256) throw new Error('Unexpected transfer identity')
  const { generation } = manifest
  requirePattern(generation, uuid, 'generation')
  const names = await layout(directory, generation, true)
  await checkIdentity(directory, runId, generation)
  const files = []
  for (const name of names) files.push(await record(directory, name))
  if (JSON.stringify(manifest.files) !== JSON.stringify(files)) throw new Error('Transfer file inventory or digest mismatch')
  await layout(directory, generation, true)
  return { generation, manifestSha256 }
}
