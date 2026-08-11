export interface ScryptParameters {
  readonly N: number
  readonly r: number
  readonly p: number
  readonly keyLength: number
}

export interface MigrationRecord {
  readonly name: string
  readonly checksum: string
}

export interface BackupSourceMetadata {
  readonly databaseName: string
  readonly serverVersion: string
  readonly serverVersionNumber: number
  readonly schemaVersion: string
  readonly vectorVersion: string | null
  readonly extensions: Readonly<Record<string, string>>
  readonly migrations: readonly MigrationRecord[]
  readonly tableCounts: Readonly<Record<string, string>>
}

export interface BackupManifestCore {
  readonly format: 'forge-resilience-backup'
  readonly formatVersion: 1
  readonly createdAt: string
  readonly source: BackupSourceMetadata
  readonly tool: {
    readonly pgDumpVersion: string
    readonly forgeResilienceVersion: string
  }
  readonly encryption: {
    readonly cipher: 'aes-256-gcm'
    readonly kdf: 'scrypt'
    readonly salt: string
    readonly iv: string
    readonly parameters: ScryptParameters
  }
}

export interface BackupManifest extends BackupManifestCore {
  readonly encryption: BackupManifestCore['encryption'] & {
    readonly authTag: string
  }
  readonly payload: {
    readonly file: string
    readonly sha256: string
    readonly bytes: number
  }
}

export interface BackupResult {
  readonly manifestPath: string
  readonly payloadPath: string
  readonly manifest: BackupManifest
}

export interface BackupOptions {
  readonly connectionString: string
  readonly outputDirectory: string
  readonly passphrase: Uint8Array | string
  readonly label?: string
  readonly postgresBin?: string
}

export interface VerifyOptions {
  readonly manifestPath: string
  readonly passphrase: Uint8Array | string
}

export interface RestoreOptions extends VerifyOptions {
  readonly connectionString: string
  readonly postgresBin?: string
}

export interface RestoreResult {
  readonly manifest: BackupManifest
  readonly restoredAt: string
  readonly targetServerVersion: string
  readonly tableCounts: Readonly<Record<string, string>>
}
