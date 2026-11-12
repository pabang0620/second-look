import { PaypalError } from 'paypal'
import { PayPalError, UNKNOWN_OUTCOME } from './errors.js'

const OUR_CREDENTIALS = 'Seller PayPal credentials were refused.'
const OUR_QUOTA = 'PayPal is busy. Try again shortly.'
const PROVIDER_DOWN = 'PayPal had a problem.'

// Arm tags differ per operation, so this never switches on payload.kind. It reads the status, and the declared
// error body (the API's own reason) when the arm has one.
const bodyOf = (payload) => (payload && 'body' in payload ? payload.body : undefined)
const reasonOf = (body) => ({
  issue: body?.details?.[0]?.issue || body?.name || 'ERROR',
  message: body?.message,
  debugId: body?.debugId,
})

function fromStatus(status, body, cause) {
  const { issue, message, debugId } = reasonOf(body)
  // 401 and 403 are about our credentials, not the caller's data, so they are not passed on as 4xx.
  if (status === 401 || status === 403) return new PayPalError(502, 'PROVIDER_CREDENTIALS', OUR_CREDENTIALS, { cause, debugId, retryable: false })
  if (status === 429) return new PayPalError(503, 'PROVIDER_BUSY', OUR_QUOTA, { cause, debugId })
  if (status >= 500) return new PayPalError(502, 'PROVIDER_ERROR', PROVIDER_DOWN, { cause, debugId })
  // The API refused the data we sent: same status, the API's own reason.
  return new PayPalError(status, issue, message, { cause, debugId })
}

// True when PayPal may have acted on a write although our code never saw an answer it could read.
export function isUnknownWrite(err) {
  if (!(err instanceof PaypalError)) return false
  if (err.kind === 'connection' || err.kind === 'timeout') return true
  return err.kind === 'decode' && err.status >= 200 && err.status < 300
}

export const unknownOutcome = (cause) => new PayPalError(0, UNKNOWN_OUTCOME, 'PayPal did not confirm this action. Checking with PayPal.', { cause })

// Turns whatever the SDK threw into the app's PayPalError. Errors outside the SDK family (an abort reason, a bug) pass
// through untouched. `write` decides what "no answer" means: unknown for a write, a plain network error for a read.
export function toPayPalError(err, { write }) {
  if (err instanceof PayPalError) return err
  if (!(err instanceof PaypalError)) return err
  switch (err.kind) {
    case 'api':
      return fromStatus(err.status, bodyOf(err.payload), err)
    case 'decode':
      if (err.status >= 200 && err.status < 300) return write ? unknownOutcome(err) : new PayPalError(0, 'NETWORK', 'PayPal sent an answer that could not be read', { cause: err })
      // The API refused the request and only the detail was lost: keep the status it answered with.
      return err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500
        ? fromStatus(err.status, undefined, err)
        : new PayPalError(err.status, 'UNREADABLE_ERROR_BODY', 'PayPal rejected the request', { cause: err })
    case 'connection':
    case 'timeout':
      return write ? unknownOutcome(err) : new PayPalError(0, 'NETWORK', 'PayPal did not answer', { cause: err })
    case 'auth':
      return new PayPalError(502, 'CREDENTIAL_FAILED', OUR_CREDENTIALS, { cause: err, retryable: false })
    case 'encode':
      return new PayPalError(500, 'ENCODE_FAILED', 'The request to PayPal could not be built', { cause: err, retryable: false })
    default:
      return err
  }
}
