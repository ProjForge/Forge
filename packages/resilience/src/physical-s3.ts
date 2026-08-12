import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hashFile } from './crypto.js'
import { parsePhysicalManifest, verifyPhysicalPackage } from './physical.js'
import { AwsS3ReplicationClient, type S3ReplicationClient } from './s3.js'
import type { PhysicalPackageResult, ReplicatedPackage, S3ReplicationTarget } from './types.js'

function key(prefix: string, file: string): string {
  return prefix.length === 0 ? file : `${prefix}/${file}`
}

function safeManifestName(value: string): string {
  if (path.posix.basename(value) !== value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}\.forge-physical\.json$/.test(value)) {
    throw new Error('S3 manifest name must be a safe FORGE physical manifest file name')
  }
  return value
}

export async function replicatePhysicalPackageToS3(
  physical: PhysicalPackageResult,
  target: S3ReplicationTarget,
  passphrase: Uint8Array | string,
  now = new Date(),
  suppliedClient?: S3ReplicationClient,
): Promise<ReplicatedPackage> {
  const client = suppliedClient ?? new AwsS3ReplicationClient(target)
  const payloadName = path.basename(physical.payloadPath)
  const manifestName = path.basename(physical.manifestPath)
  const payloadKey = key(target.prefix, payloadName)
  const manifestKey = key(target.prefix, manifestName)
  const retainUntil = new Date(now.getTime() + target.objectLock.retentionDays * 86_400_000)
  try {
    if (physical.manifest.payload.file !== payloadName || path.basename(physical.manifestPath) !== manifestName) {
      throw new Error('Physical package paths do not match its manifest')
    }
    await verifyPhysicalPackage(physical.manifestPath, passphrase)
    const manifestHash = await hashFile(physical.manifestPath)
    await client.putObject({
      bucket: target.bucket, key: payloadKey, file: physical.payloadPath,
      contentType: 'application/octet-stream',
      metadata: { 'forge-format': physical.manifest.format, 'forge-kind': physical.manifest.kind, 'forge-sha256': physical.manifest.payload.sha256 },
      checksumSha256: Buffer.from(physical.manifest.payload.sha256, 'hex').toString('base64'),
      objectLockMode: target.objectLock.mode, retainUntil,
    })
    await client.putObject({
      bucket: target.bucket, key: manifestKey, file: physical.manifestPath,
      contentType: 'application/json', metadata: { 'forge-format': physical.manifest.format, 'forge-kind': physical.manifest.kind },
      checksumSha256: Buffer.from(manifestHash.sha256, 'hex').toString('base64'),
      objectLockMode: target.objectLock.mode, retainUntil,
    })
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-physical-s3-verify-'))
    try {
      const downloadedPayload = path.join(temporary, payloadName)
      const downloadedManifest = path.join(temporary, manifestName)
      await client.downloadObject({ bucket: target.bucket, key: payloadKey, destination: downloadedPayload })
      await client.downloadObject({ bucket: target.bucket, key: manifestKey, destination: downloadedManifest })
      const verified = await verifyPhysicalPackage(downloadedManifest, passphrase)
      if (await readFile(downloadedManifest, 'utf8') !== await readFile(physical.manifestPath, 'utf8') ||
          verified.payload.sha256 !== physical.manifest.payload.sha256) {
        throw new Error(`S3 physical replica does not match source: ${target.name}`)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    return {
      target: target.name, type: 's3',
      manifestLocation: `s3://${target.bucket}/${manifestKey}`,
      payloadLocation: `s3://${target.bucket}/${payloadKey}`,
      manifestPath: `s3://${target.bucket}/${manifestKey}`,
      payloadPath: `s3://${target.bucket}/${payloadKey}`,
    }
  } finally {
    if (suppliedClient === undefined) client.close?.()
  }
}

export async function fetchPhysicalPackageFromS3(
  target: S3ReplicationTarget,
  manifestName: string,
  outputDirectory: string,
  passphrase: Uint8Array | string,
  suppliedClient?: S3ReplicationClient,
): Promise<PhysicalPackageResult> {
  const name = safeManifestName(manifestName)
  const directory = path.resolve(outputDirectory)
  await mkdir(directory, { recursive: true })
  const manifestPath = path.join(directory, name)
  if (existsSync(manifestPath)) throw new Error(`Physical manifest already exists: ${manifestPath}`)
  const temporary = await mkdtemp(path.join(directory, '.forge-physical-fetch-'))
  const client = suppliedClient ?? new AwsS3ReplicationClient(target)
  let payloadPath: string | undefined
  let payloadPublished = false
  try {
    const temporaryManifest = path.join(temporary, name)
    await client.downloadObject({ bucket: target.bucket, key: key(target.prefix, name), destination: temporaryManifest })
    const manifest = parsePhysicalManifest(JSON.parse(await readFile(temporaryManifest, 'utf8')) as unknown)
    payloadPath = path.join(directory, manifest.payload.file)
    if (existsSync(payloadPath)) throw new Error(`Physical payload already exists: ${payloadPath}`)
    const temporaryPayload = path.join(temporary, manifest.payload.file)
    await client.downloadObject({ bucket: target.bucket, key: key(target.prefix, manifest.payload.file), destination: temporaryPayload })
    const verified = await verifyPhysicalPackage(temporaryManifest, passphrase)
    await rename(temporaryPayload, payloadPath)
    payloadPublished = true
    await rename(temporaryManifest, manifestPath)
    return { manifestPath, payloadPath, manifest: verified }
  } catch (error) {
    if (payloadPublished && payloadPath) await rm(payloadPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
    if (suppliedClient === undefined) client.close?.()
  }
}
