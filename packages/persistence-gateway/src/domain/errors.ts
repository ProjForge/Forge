export class ForgeGatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = new.target.name
  }
}

export class NotFoundError extends ForgeGatewayError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} not found in the requested project: ${id}`)
  }
}

export class ConflictError extends ForgeGatewayError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONFLICT', message, options)
  }
}

export class IdempotencyConflictError extends ForgeGatewayError {
  constructor(scope: string, key: string) {
    super('IDEMPOTENCY_CONFLICT', `Idempotency key was reused with a different request: ${scope}/${key}`)
  }
}

export class OptimisticLockError extends ForgeGatewayError {
  constructor(entity: string, id: string, expectedVersion: number) {
    super('OPTIMISTIC_LOCK_FAILED', `${entity} ${id} is not at expected version ${expectedVersion}`)
  }
}

export class SchemaCompatibilityError extends ForgeGatewayError {
  constructor(message: string) {
    super('SCHEMA_INCOMPATIBLE', message)
  }
}
