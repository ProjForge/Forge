import { validateIdentifier } from '../../packages/schema/scripts/admin-helpers.mjs'

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:'])

export function parseConnectionUrl(value, name = 'connection URL') {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`)
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw new Error(`${name} must include PostgreSQL protocol, host, user and database`)
  }
  if (parsed.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error(`${name} must use sslmode=verify-full`)
  }
  return parsed
}

export function deriveConnectionUrl(base, database, user, password) {
  const parsed = new URL(base.toString())
  parsed.pathname = `/${validateIdentifier(database, 'database name')}`
  if (user !== undefined) parsed.username = user
  if (password !== undefined) parsed.password = password
  return parsed.toString()
}

export function namesForRun(value) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30)
  if (!normalized) throw new Error('FORGE_TENCENTDB_RUN_ID must contain letters or numbers')
  const safe = /^[a-z_]/.test(normalized) ? normalized : `r_${normalized}`
  return {
    database: validateIdentifier(`forge_tc_${safe}`, 'database name'),
    role: validateIdentifier(`forge_tc_${safe}_runtime`, 'runtime role'),
  }
}

export function versionAtLeast(actual, minimum) {
  const parse = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10))
  const left = parse(actual)
  const right = parse(minimum)
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return false
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

export function redactSecrets(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://***:***@redacted/redacted')
    .replace(/(password|secret|token)=([^\s&]+)/gi, '$1=***')
}
