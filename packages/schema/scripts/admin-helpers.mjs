export function validateIdentifier(value, name) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError(`${name} must use lowercase PostgreSQL identifier syntax`)
  }
  return value
}

export function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}

export function requiredSecret(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.length < 12) throw new Error(`${name} must contain at least 12 characters`)
  return value
}
