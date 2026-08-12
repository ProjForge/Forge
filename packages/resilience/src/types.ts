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

export interface FilesystemReplicationTarget {
  readonly name: string
  readonly type?: 'filesystem'
  readonly path: string
}

export interface S3ObjectLockPolicy {
  readonly mode: 'GOVERNANCE' | 'COMPLIANCE'
  readonly retentionDays: number
}

export interface S3ReplicationTarget {
  readonly name: string
  readonly type: 's3'
  readonly bucket: string
  readonly prefix: string
  readonly region: string
  readonly endpoint?: string
  readonly forcePathStyle?: boolean
  readonly objectLock: S3ObjectLockPolicy
}

export type ReplicationTarget = FilesystemReplicationTarget | S3ReplicationTarget

export interface RetentionPolicy {
  readonly keepLast: number
  readonly maxAgeHours?: number
}

export interface RecoveryPolicy {
  readonly version: 1
  readonly outputDirectory: string
  readonly replicas: readonly ReplicationTarget[]
  readonly retention: RetentionPolicy
  readonly labelPrefix?: string
  readonly lockPath?: string
  readonly statusPath?: string
}

export interface PolicyRunOptions {
  readonly connectionString: string
  readonly passphrase: Uint8Array | string
  readonly policy: RecoveryPolicy
  readonly postgresBin?: string
  readonly now?: Date
}

export interface ReplicatedPackage {
  readonly target: string
  readonly type: 'filesystem' | 's3'
  readonly manifestLocation: string
  readonly payloadLocation: string
  readonly manifestPath: string
  readonly payloadPath: string
}

export interface PolicyRunResult {
  readonly startedAt: string
  readonly completedAt: string
  readonly backup: BackupResult
  readonly replicas: readonly ReplicatedPackage[]
  readonly prunedFiles: readonly string[]
}

export type PhysicalArtifactKind = 'wal' | 'base-backup'

export interface PhysicalClusterIdentity {
  readonly systemIdentifier: string
  readonly serverVersion: string
  readonly serverVersionNumber: number
  readonly timeline: number
}

export interface PhysicalManifestCore {
  readonly format: 'forge-resilience-physical'
  readonly formatVersion: 1
  readonly createdAt: string
  readonly kind: PhysicalArtifactKind
  readonly cluster: PhysicalClusterIdentity
  readonly source: {
    readonly file: string
    readonly sha256: string
    readonly bytes: number
  }
  readonly tool: { readonly forgeResilienceVersion: string }
  readonly encryption: BackupManifestCore['encryption']
}

export interface PhysicalManifest extends PhysicalManifestCore {
  readonly encryption: PhysicalManifestCore['encryption'] & { readonly authTag: string }
  readonly payload: {
    readonly file: string
    readonly sha256: string
    readonly bytes: number
  }
}

export interface PhysicalPackageResult {
  readonly manifestPath: string
  readonly payloadPath: string
  readonly manifest: PhysicalManifest
}

export interface CreatePhysicalPackageOptions {
  readonly sourcePath: string
  readonly outputDirectory: string
  readonly passphrase: Uint8Array | string
  readonly kind: PhysicalArtifactKind
  readonly cluster: PhysicalClusterIdentity
  readonly label?: string
}
