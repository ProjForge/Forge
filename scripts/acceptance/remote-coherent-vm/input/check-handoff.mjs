import { verifyTransferManifest } from './remote-coherent-transfer.mjs'

const [directory, runId, recipientSha256, manifestSha256] = process.argv.slice(2)
try {
  const verified = await verifyTransferManifest(directory, { runId, recipientSha256, manifestSha256 })
  console.log(JSON.stringify({ generation: verified.generation, manifestSha256: verified.manifestSha256 }))
} catch {
  console.error('The replica does not match the pinned transfer manifest')
  process.exitCode = 1
}
