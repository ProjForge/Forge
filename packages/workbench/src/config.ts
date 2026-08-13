import { loadSemanticBridgeConfig, type SemanticBridgeConfig } from 'forge-semantic-bridge/workbench'
import type { RecoveryHealthConfig } from './recovery-health.js'

export interface WorkbenchConfig {
  host: '127.0.0.1' | '::1'
  port: number
  semantic: SemanticBridgeConfig
  recovery: RecoveryHealthConfig
}

function port(env: NodeJS.ProcessEnv): number {
  const value = Number(env.FORGE_WORKBENCH_PORT ?? 7334)
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError('FORGE_WORKBENCH_PORT must be an integer between 0 and 65535')
  }
  return value
}

export function loadWorkbenchConfig(env: NodeJS.ProcessEnv = process.env): WorkbenchConfig {
  const host = env.FORGE_WORKBENCH_HOST?.trim() || '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new TypeError('FORGE Workbench may only bind to a loopback address')
  }
  return {
    host, port: port(env), semantic: loadSemanticBridgeConfig(env),
    recovery: {
      ...(env.FORGE_LOGICAL_RECOVERY_STATUS ? { logicalStatusPath: env.FORGE_LOGICAL_RECOVERY_STATUS } : {}),
      ...(env.FORGE_PITR_MONITOR_STATUS ? { pitrStatusPath: env.FORGE_PITR_MONITOR_STATUS } : {}),
      ...(env.FORGE_PHYSICAL_UPLOADER_STATUS ? { walTransportStatusPath: env.FORGE_PHYSICAL_UPLOADER_STATUS } : {}),
      ...(env.FORGE_PHYSICAL_BASEBACKUP_STATUS ? { baseBackupStatusPath: env.FORGE_PHYSICAL_BASEBACKUP_STATUS } : {}),
    },
  }
}
