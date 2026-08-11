import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform, Writable, type Readable } from 'node:stream'
import type { ScryptParameters } from './types.js'

export const defaultScryptParameters: ScryptParameters = {
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 32,
}

export interface EncryptionMaterial {
  readonly salt: Buffer
  readonly iv: Buffer
  readonly parameters: ScryptParameters
}

export interface EncryptionResult {
  readonly authTag: Buffer
  readonly sha256: string
  readonly bytes: number
}

export function newEncryptionMaterial(): EncryptionMaterial {
  return {
    salt: randomBytes(16),
    iv: randomBytes(12),
    parameters: defaultScryptParameters,
  }
}

export function deriveKey(
  passphrase: Uint8Array,
  salt: Uint8Array,
  parameters: ScryptParameters,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, parameters.keyLength, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: Math.max(64 * 1024 * 1024, 256 * parameters.N * parameters.r),
    }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function encryptToFile(
  source: Readable,
  destination: string,
  passphrase: Uint8Array,
  material: EncryptionMaterial,
  authenticatedData: string,
): Promise<EncryptionResult> {
  const key = await deriveKey(passphrase, material.salt, material.parameters)
  const cipher = createCipheriv('aes-256-gcm', key, material.iv)
  cipher.setAAD(Buffer.from(authenticatedData, 'utf8'))
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      callback(null, chunk)
    },
  })

  try {
    await pipeline(source, cipher, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
    return { authTag: cipher.getAuthTag(), sha256: hash.digest('hex'), bytes }
  } finally {
    key.fill(0)
  }
}

function discardSink(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback() } })
}

export async function decryptFile(
  source: string,
  destination: Writable,
  passphrase: Uint8Array,
  salt: Uint8Array,
  iv: Uint8Array,
  authTag: Uint8Array,
  parameters: ScryptParameters,
  authenticatedData: string,
): Promise<void> {
  const key = await deriveKey(passphrase, salt, parameters)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(authenticatedData, 'utf8'))
  decipher.setAuthTag(Buffer.from(authTag))
  try {
    await pipeline(createReadStream(source), decipher, destination)
  } finally {
    key.fill(0)
  }
}

export async function verifyAuthentication(
  source: string,
  passphrase: Uint8Array,
  salt: Uint8Array,
  iv: Uint8Array,
  authTag: Uint8Array,
  parameters: ScryptParameters,
  authenticatedData: string,
): Promise<void> {
  await decryptFile(source, discardSink(), passphrase, salt, iv, authTag, parameters, authenticatedData)
}

export async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  await pipeline(
    createReadStream(file),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        bytes += chunk.length
        callback()
      },
    }),
  )
  return { sha256: hash.digest('hex'), bytes }
}
