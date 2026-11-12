export class PayPalError extends Error {
  // extra.retryable overrides the status rule (a refused credential must not be retried even though its status is 5xx).
  // extra.debugId is PayPal's correlation id, kept for the app's own trace. extra.cause is the SDK error, kept for logs.
  constructor(status, issue, message, extra = {}) {
    super(message || `PayPal ${issue} (${status})`, extra.cause ? { cause: extra.cause } : undefined)
    this.status = status
    this.issue = issue
    this.debugId = extra.debugId || null
    // 5xx and network failures are the only ones worth retrying with the same Request-Id.
    this.retryable = extra.retryable ?? (status >= 500 || status === 0)
  }
}

// The outcome of a write is not known: PayPal may have acted. Never reported as "failed".
export const UNKNOWN_OUTCOME = 'UNKNOWN_OUTCOME'
