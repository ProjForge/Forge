import { loadSemanticBridgeConfig, type SemanticBridgeConfig } from 'forge-semantic-bridge/workbench'

export interface WorkbenchConfig {
  host: '127.0.0.1' | '::1'
  port: number
  semantic: SemanticBridgeConfig
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
  return { host, port: port(env), semantic: loadSemanticBridgeConfig(env) }
}
