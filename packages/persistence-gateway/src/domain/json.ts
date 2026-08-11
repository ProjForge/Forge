import { createHash } from 'node:crypto'

export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite')
    return value
  }

  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : canonicalize(item))
  }

  if (typeof value === 'object') {
    const result: JsonObject = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) result[key] = canonicalize(item)
    }
    return result
  }

  throw new TypeError(`Unsupported JSON value: ${typeof value}`)
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}
