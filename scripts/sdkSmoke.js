// Read-only smoke of the SDK adapter against one seller's real sandbox credential. Run by a person, never by tests.
// It reads a made-up order id and a made-up authorization id: PayPal must answer 404 or 400 with an error body that the
// SDK decodes, which proves host, credentials, token fetch, request building and error decoding without moving money.
// Usage: SMOKE_SELLER=power_company node scripts/sdkSmoke.js   (reads .env; SMOKE_ORDER_ID optional, reads that order too)
import 'dotenv/config'
import { createPayeeRegistry } from '../server/paypal/payees.js'
import { createGateway } from '../server/paypal/gateway.js'
import { createSdkClients } from '../server/paypal/sdkClient.js'
import { toPayPalError } from '../server/paypal/sdkErrors.js'
import { loadConfig } from '../server/config.js'

const out = (line) => process.stdout.write(`${line}\n`)
const key = process.env.SMOKE_SELLER || 'power_company'
const config = loadConfig()
const registry = createPayeeRegistry(process.env)
const payee = registry.get(key)
if (!payee || payee.credentials.mode !== 'sandbox') {
  out(`SMOKE: seller ${key} has no sandbox credentials in .env`)
  process.exit(2)
}

const gateway = createGateway({ registry, apiBase: config.paypalApiBase, now: Date.now, publicUrl: config.publicUrl })
const client = createSdkClients({ apiBase: config.paypalApiBase }).clientFor(payee)
const expectRefusal = async (label, run) => {
  try {
    await run()
    out(`${label}: unexpected success`)
    return false
  } catch (err) {
    const ok = err?.status === 404 || err?.status === 400
    out(`${label}: status ${err?.status} issue ${err?.issue} ${ok ? 'OK' : 'UNEXPECTED'}`)
    return ok
  }
}

const results = [
  await expectRefusal('getOrder (made-up id)', () => gateway.getOrder(payee, 'SMOKE0000NOTANORDER')),
  await expectRefusal('getAuthorizedPayment (made-up id)', () => client.payments.getAuthorizedPayment({ authorizationId: 'SMOKE0000NOTAAUTH' }).catch((err) => { throw toPayPalError(err, { write: false }) })),
]
if (process.env.SMOKE_ORDER_ID) {
  const order = await gateway.getOrder(payee, process.env.SMOKE_ORDER_ID)
  out(`getOrder (your order): status ${order.status} id ${order.id}`)
}
process.exit(results.every(Boolean) ? 0 : 1)
