export class EmbeddingWorkerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = new.target.name
  }
}

export class EmbeddingProviderError extends EmbeddingWorkerError {
  constructor(
    code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(code, message, options)
  }
}
