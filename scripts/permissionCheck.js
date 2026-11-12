// VERIFY V14: does PayPal itself refuse another merchant's app? Run by a person, never by tests.
// Needs two sellers with sandbox apps in .env. AUTH_ID is an authorization of seller OWNER (an order that seller's app
// authorized, for example from scenario 1 before you press Stop). Seller OTHER's credential then tries to touch it.
// Default: a read (getAuthorizedPayment), which cannot move money even if PayPal allows it.
// With PERMISSION_TRY_CAPTURE=1 it tries a capture instead, which WOULD capture if PayPal wrongly allowed it.
// Usage: OWNER=mobility_direct OTHER=maple_lane AUTH_ID=<authorization id> node scripts/permissionCheck.js
import 'dotenv/config'
import { createPayeeRegistry } from '../server/paypal/payees.js'
import { createSdkClients } from '../server/paypal/sdkClient.js'
import { toPayPalError } from '../server/paypal/sdkErrors.js'
import { loadConfig } from '../server/config.js'

const out = (line) => process.stdout.write(`${line}\n`)
const { OWNER, OTHER, AUTH_ID } = process.env
const config = loadConfig()
const registry = createPayeeRegistry(process.env)
const other = registry.get(OTHER || '')
if (!OWNER || !AUTH_ID || !other || other.credentials.mode !== 'sandbox') {
  out('PERMISSION CHECK: set OWNER, OTHER (a seller with sandbox keys) and AUTH_ID')
  process.exit(2)
}
if (registry.get(OWNER)?.credentials.clientId === other.credentials.clientId) {
  out('PERMISSION CHECK: OWNER and OTHER use the same REST app, so this proves nothing (VERIFY V3 needs two apps)')
  process.exit(2)
}

const client = createSdkClients({ apiBase: config.paypalApiBase }).clientFor(other)
const capture = process.env.PERMISSION_TRY_CAPTURE === '1'
try {
  if (capture) await client.payments.captureAuthorizedPayment({ authorizationId: AUTH_ID, payPalRequestId: `permcheck-${Date.now()}`, body: { finalCapture: true } })
  else await client.payments.getAuthorizedPayment({ authorizationId: AUTH_ID })
  out(`${capture ? 'capture' : 'read'} by ${OTHER} of ${OWNER}'s authorization: PayPal ALLOWED it`)
  process.exit(1)
} catch (err) {
  const e = toPayPalError(err, { write: false })
  out(`${capture ? 'capture' : 'read'} by ${OTHER} of ${OWNER}'s authorization: status ${e.status} issue ${e.issue}`)
  process.exit(0)
}
