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
    const info = lstatSync(root, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Report root must not be a link')
    this.targetId = this.targetIdentity()
  }

  private targetIdentity(): string {
    const canonical = realpathSync(this.root)
    const info = lstatSync(this.root, { bigint: true })
    return targetIdentity(canonical, info.dev, info.ino)
  }

  async publish({ key, artifact, signal, expected }: Parameters<ArtifactPublisher['publish']>[0]): Promise<EffectReceipt> {
    signal.throwIfAborted()
    const { bytes, receipt } = reportIdentity(key, artifact, this.targetId)
    if (expected && (expected.kind !== receipt.kind || expected.key !== key || expected.sha256 !== receipt.sha256 || expected.filename !== receipt.filename || expected.targetId !== this.targetId)) throw new PilotFailure('EFFECT_CONFLICT')
    const rootInfo = await lstat(this.root, { bigint: true })
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Report root must not be a link')
    if (this.targetIdentity() !== this.targetId) throw new PilotFailure('EFFECT_TARGET_CHANGED')
    const root = await realpath(this.root)
    const destination = path.join(root, receipt.filename)
    const verify = async (): Promise<boolean> => {
      try {
        const before = await lstat(destination, { bigint: true })
        if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(bytes.length)) throw new PilotFailure('EFFECT_CONFLICT')
        const file = await open(destination, 'r')
        try {
          const current = await file.stat({ bigint: true })
          if (current.dev !== before.dev || current.ino !== before.ino || current.size !== BigInt(bytes.length)) throw new PilotFailure('EFFECT_CONFLICT')
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

export type ReportTargetProof =
  | { version: 2; canonicalPath: string; dev: string; ino: string }
  | { version?: undefined; canonicalPath: string; dev: number; ino: number }

const normalizePath = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value

function targetIdentity(canonical: string, dev: bigint, ino: bigint): string {
  // Preserve historical hashes only where the numeric identity was lossless.
  const safe = dev <= BigInt(Number.MAX_SAFE_INTEGER) && ino <= BigInt(Number.MAX_SAFE_INTEGER)
  const identity = safe ? `${normalizePath(canonical)}:${dev}:${ino}`
    : `report-target-v2:${JSON.stringify([normalizePath(canonical), dev.toString(), ino.toString()])}`
  return createHash('sha256').update(identity).digest('hex')
}

function proofIdentity(proof: unknown): { canonicalPath: string; dev: bigint; ino: bigint } {
  if (!proof || typeof proof !== 'object') throw new PilotFailure('EFFECT_TARGET_CHANGED')
  const value = proof as Record<string, unknown>
  if (typeof value.canonicalPath !== 'string') throw new PilotFailure('EFFECT_TARGET_CHANGED')
  const exact = (id: unknown): bigint => {
    if (value.version === 2 && typeof id === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(id) && BigInt(id) <= 18446744073709551615n) return BigInt(id)
    if (value.version === undefined && typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) return BigInt(id)
    throw new PilotFailure('EFFECT_TARGET_CHANGED')
  }
  return { canonicalPath: value.canonicalPath, dev: exact(value.dev), ino: exact(value.ino) }
}

export function captureReportTarget(root: string): ReportTargetProof {
  new ImmutableReportPublisher(root)
  const info = lstatSync(root, { bigint: true })
  return { version: 2, canonicalPath: realpathSync(root), dev: info.dev.toString(), ino: info.ino.toString() }
}

// Verification-only adapter: physical identity substitution never leaves this verifier.
export class RestoredReportVerifier implements ArtifactPublisher {
  readonly kind = 'immutable-report-v1' as const
  readonly targetId: string
  private readonly replacement: ImmutableReportPublisher
  constructor(root: string, proof: unknown) {
    this.replacement = new ImmutableReportPublisher(root)
    const original = proofIdentity(proof)
    if (normalizePath(realpathSync(root)) !== normalizePath(original.canonicalPath)) throw new PilotFailure('EFFECT_TARGET_CHANGED')
    this.targetId = targetIdentity(original.canonicalPath, original.dev, original.ino)
    if (this.targetId === this.replacement.targetId) throw new PilotFailure('EFFECT_TARGET_CHANGED')
  }
  async publish(input: Parameters<ArtifactPublisher['publish']>[0]): Promise<EffectReceipt> {
    const expected = input.expected
    const original = reportIdentity(input.key, input.artifact, this.targetId).receipt
    if (!expected || Object.keys(original).some(key => original[key as keyof EffectReceipt] !== expected[key as keyof EffectReceipt])) throw new PilotFailure('EFFECT_UNCONFIRMED')
    await this.replacement.publish({ ...input, expected: { ...expected, targetId: this.replacement.targetId } })
    return expected
  }
}
