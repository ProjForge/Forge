import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import type { Artifact, ArtifactPublisher, EffectReceipt } from './types.js'
import { PilotFailure } from './types.js'

export function reportIdentity(key: string, artifact: Artifact, targetId: string): { bytes: Buffer; receipt: EffectReceipt } {
  const bytes = Buffer.from(`# ${artifact.title}\n\n${artifact.content}\n`, 'utf8')
  if (bytes.length > 132_000 || !key || key.length > 200) throw new Error('Invalid report payload')
  return { bytes, receipt: { kind: 'immutable-report-v1', key, targetId, sha256: createHash('sha256').update(bytes).digest('hex'),
    filename: `${createHash('sha256').update(key).digest('hex')}.report.md` } }
}

export class ImmutableReportPublisher implements ArtifactPublisher {
  readonly kind = 'immutable-report-v1' as const
  readonly targetId: string
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root) || root.startsWith('\\\\')) throw new Error('Report root must be an absolute local directory')
    const info = lstatSync(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Report root must not be a link')
    this.targetId = this.targetIdentity()
  }

  private targetIdentity(): string {
    const canonical = realpathSync(this.root)
    const info = lstatSync(this.root)
    return createHash('sha256').update(`${process.platform === 'win32' ? canonical.toLowerCase() : canonical}:${info.dev}:${info.ino}`).digest('hex')
  }

  async publish({ key, artifact, signal, expected }: Parameters<ArtifactPublisher['publish']>[0]): Promise<EffectReceipt> {
    signal.throwIfAborted()
    const { bytes, receipt } = reportIdentity(key, artifact, this.targetId)
    if (expected && (expected.kind !== receipt.kind || expected.key !== key || expected.sha256 !== receipt.sha256 || expected.filename !== receipt.filename || expected.targetId !== this.targetId)) throw new PilotFailure('EFFECT_CONFLICT')
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Report root must not be a link')
    if (this.targetIdentity() !== this.targetId) throw new PilotFailure('EFFECT_TARGET_CHANGED')
    const root = await realpath(this.root)
    const destination = path.join(root, receipt.filename)
    const verify = async (): Promise<boolean> => {
      try {
        const before = await lstat(destination)
        if (!before.isFile() || before.isSymbolicLink() || before.size !== bytes.length) throw new PilotFailure('EFFECT_CONFLICT')
        const file = await open(destination, 'r')
        try {
          const current = await file.stat()
          if (current.dev !== before.dev || current.ino !== before.ino || current.size !== bytes.length) throw new PilotFailure('EFFECT_CONFLICT')
          const content = Buffer.alloc(bytes.length + 1)
          let size = 0
          while (size < content.length) {
            const read = await file.read(content, size, content.length - size, size)
            if (!read.bytesRead) break
            size += read.bytesRead
          }
          if (size !== bytes.length || !content.subarray(0, size).equals(bytes)) throw new PilotFailure('EFFECT_CONFLICT')
        } finally { await file.close() }
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }
    if (await verify()) return receipt
    if (expected) throw new PilotFailure('EFFECT_UNCONFIRMED')
    signal.throwIfAborted()
    const temporary = path.join(root, `.forge-report-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      signal.throwIfAborted()
      // Atomic create-if-absent: never truncate or overwrite the destination.
      try { await link(temporary, destination) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      if (!await verify()) throw new Error('External report publication could not be confirmed')
      return receipt
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
  }
}
