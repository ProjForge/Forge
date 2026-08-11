import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type ObjectLockRetentionMode,
} from '@aws-sdk/client-s3'
import { verifyBackup } from './restore.js'
import { hashFile } from './crypto.js'
import { parseManifest } from './manifest.js'
import type { BackupResult, ReplicatedPackage, S3ReplicationTarget } from './types.js'

export interface S3PutRequest {
  readonly bucket: string
  readonly key: string
  readonly file: string
  readonly contentType: string
  readonly metadata: Readonly<Record<string, string>>
  readonly checksumSha256: string
  readonly objectLockMode: S3ReplicationTarget['objectLock']['mode']
  readonly retainUntil: Date
}

export interface S3DownloadRequest {
  readonly bucket: string
  readonly key: string
  readonly destination: string
}

export interface S3ReplicationClient {
  putObject(request: S3PutRequest): Promise<void>
  downloadObject(request: S3DownloadRequest): Promise<void>
  close?(): void
}

class AwsS3ReplicationClient implements S3ReplicationClient {
  readonly #client: S3Client

  constructor(target: S3ReplicationTarget) {
    this.#client = new S3Client({
      region: target.region,
      ...(target.endpoint ? { endpoint: target.endpoint } : {}),
      ...(target.forcePathStyle === undefined ? {} : { forcePathStyle: target.forcePathStyle }),
    })
  }

  async putObject(request: S3PutRequest): Promise<void> {
    const file = await stat(request.file)
    await this.#client.send(new PutObjectCommand({
      Bucket: request.bucket,
      Key: request.key,
      Body: createReadStream(request.file),
      ContentLength: file.size,
      ContentType: request.contentType,
      Metadata: { ...request.metadata },
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: request.checksumSha256,
      ObjectLockMode: request.objectLockMode as ObjectLockRetentionMode,
      ObjectLockRetainUntilDate: request.retainUntil,
    }))
  }

  async downloadObject(request: S3DownloadRequest): Promise<void> {
    const response = await this.#client.send(new GetObjectCommand({ Bucket: request.bucket, Key: request.key }))
    if (!response.Body) throw new Error(`S3 object has no body: s3://${request.bucket}/${request.key}`)
    await pipeline(response.Body as Readable, createWriteStream(request.destination, { flags: 'wx', mode: 0o600 }))
  }

  close(): void {
    this.#client.destroy()
  }
}

function objectKey(prefix: string, file: string): string {
  return prefix.length === 0 ? file : `${prefix}/${file}`
}

function location(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`
}

function manifestObjectName(value: string): string {
  if (path.posix.basename(value) !== value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}\.forge-backup\.json$/.test(value)) {
    throw new Error('S3 manifest name must be a safe FORGE backup manifest file name')
  }
  return value
}

export async function fetchBackupFromS3(
  target: S3ReplicationTarget,
  manifestName: string,
  outputDirectory: string,
  passphrase: Uint8Array | string,
  suppliedClient?: S3ReplicationClient,
): Promise<BackupResult> {
  const safeManifestName = manifestObjectName(manifestName)
  const directory = path.resolve(outputDirectory)
  await mkdir(directory, { recursive: true })
  const manifestPath = path.join(directory, safeManifestName)
  if (existsSync(manifestPath)) throw new Error(`Backup manifest already exists: ${manifestPath}`)
  const temporary = await mkdtemp(path.join(directory, '.forge-s3-fetch-'))
  let client: S3ReplicationClient | undefined
  let payloadPath: string | undefined
  let payloadPublished = false
  try {
    client = suppliedClient ?? new AwsS3ReplicationClient(target)
    const temporaryManifest = path.join(temporary, safeManifestName)
    await client.downloadObject({
      bucket: target.bucket,
      key: objectKey(target.prefix, safeManifestName),
      destination: temporaryManifest,
    })
    const manifest = parseManifest(JSON.parse(await readFile(temporaryManifest, 'utf8')) as unknown)
    payloadPath = path.join(directory, manifest.payload.file)
    if (existsSync(payloadPath)) throw new Error(`Backup payload already exists: ${payloadPath}`)
    const temporaryPayload = path.join(temporary, manifest.payload.file)
    await client.downloadObject({
      bucket: target.bucket,
      key: objectKey(target.prefix, manifest.payload.file),
      destination: temporaryPayload,
    })
    const verified = await verifyBackup({ manifestPath: temporaryManifest, passphrase })
    await rename(temporaryPayload, payloadPath)
    payloadPublished = true
    await rename(temporaryManifest, manifestPath)
    return { manifestPath, payloadPath, manifest: verified }
  } catch (error) {
    if (payloadPublished && payloadPath) await rm(payloadPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
    if (suppliedClient === undefined) client?.close?.()
  }
}

export async function replicateBackupToS3(
  backup: BackupResult,
  target: S3ReplicationTarget,
  passphrase: Uint8Array | string,
  now = new Date(),
  suppliedClient?: S3ReplicationClient,
): Promise<ReplicatedPackage> {
  const client = suppliedClient ?? new AwsS3ReplicationClient(target)
  const payloadName = path.basename(backup.payloadPath)
  const manifestName = path.basename(backup.manifestPath)
  const payloadKey = objectKey(target.prefix, payloadName)
  const manifestKey = objectKey(target.prefix, manifestName)
  const retainUntil = new Date(now.getTime() + target.objectLock.retentionDays * 24 * 60 * 60 * 1000)

  try {
    const manifestHash = await hashFile(backup.manifestPath)
    await client.putObject({
      bucket: target.bucket,
      key: payloadKey,
      file: backup.payloadPath,
      contentType: 'application/octet-stream',
      metadata: {
        'forge-format': backup.manifest.format,
        'forge-sha256': backup.manifest.payload.sha256,
      },
      checksumSha256: Buffer.from(backup.manifest.payload.sha256, 'hex').toString('base64'),
      objectLockMode: target.objectLock.mode,
      retainUntil,
    })
    await client.putObject({
      bucket: target.bucket,
      key: manifestKey,
      file: backup.manifestPath,
      contentType: 'application/json',
      metadata: { 'forge-format': backup.manifest.format },
      checksumSha256: Buffer.from(manifestHash.sha256, 'hex').toString('base64'),
      objectLockMode: target.objectLock.mode,
      retainUntil,
    })

    const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-s3-verify-'))
    try {
      const downloadedPayload = path.join(temporary, payloadName)
      const downloadedManifest = path.join(temporary, manifestName)
      await client.downloadObject({ bucket: target.bucket, key: payloadKey, destination: downloadedPayload })
      await client.downloadObject({ bucket: target.bucket, key: manifestKey, destination: downloadedManifest })
      const remoteManifest = await verifyBackup({ manifestPath: downloadedManifest, passphrase })
      const sourceManifest = await readFile(backup.manifestPath, 'utf8')
      const verifiedManifest = await readFile(downloadedManifest, 'utf8')
      if (sourceManifest !== verifiedManifest || remoteManifest.payload.sha256 !== backup.manifest.payload.sha256) {
        throw new Error(`S3 replica manifest does not match source: ${target.name}`)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }

    const manifestLocation = location(target.bucket, manifestKey)
    const payloadLocation = location(target.bucket, payloadKey)
    return {
      target: target.name,
      type: 's3',
      manifestLocation,
      payloadLocation,
      manifestPath: manifestLocation,
      payloadPath: payloadLocation,
    }
  } finally {
    if (suppliedClient === undefined) client.close?.()
  }
}
