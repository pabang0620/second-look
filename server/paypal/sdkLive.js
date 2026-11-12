import {
  AuthorizationStatus,
  CheckoutPaymentIntent,
  PayPalWalletContextShippingPreference,
  capturedPaymentSchema,
  orderAuthorizeResponseSchema,
  orderSchema,
} from 'paypal'
import { toValue } from '../money.js'
import { isUnknownWrite, toPayPalError, unknownOutcome } from './sdkErrors.js'

// Writes are POSTs, outside the SDK's default retry gate, so the SDK sends each one once. The only resend is the
// lifecycle's own retry, which reuses the same PayPal-Request-Id. maxRetries 0 states that on every write.
const ONCE = Object.freeze({ retry: Object.freeze({ maxRetries: 0 }) })

const authorizationOf = (order) => order?.purchase_units?.[0]?.payments?.authorizations?.[0] || null
const captureOf = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0] || null

// The five calls the app makes against PayPal's Orders and Payments APIs, through the APIMatic SDK. The SDK decodes into
// camelCase models; the rest of the app reads PayPal's wire shape, so every result goes back through the SDK's own
// schema `encode`. Same gateway interface and same PayPalError as the mock and the REST adapter.
export function createSdkLive({ clients }) {
  async function readOrder(client, orderId) {
    return orderSchema.encode(await client.orders.getOrder({ id: orderId }))
  }

  // ----- unknown outcomes: re-read by the reference we hold. Not found, or the re-read fails: still unknown. -----

  async function settleAuthorize(client, orderId, cause) {
    try {
      const order = await readOrder(client, orderId)
      if (authorizationOf(order)) return order
    } catch {
      // the re-read failed too: still unknown
    }
    throw unknownOutcome(cause)
  }

  async function settleCapture(client, orderId, cause) {
    if (orderId) {
      try {
        const capture = captureOf(await readOrder(client, orderId))
        if (capture) return capture
      } catch {
        // the re-read failed too: still unknown
      }
    }
    throw unknownOutcome(cause)
  }

  async function settleVoid(client, authorizationId, cause) {
    try {
      const auth = await client.payments.getAuthorizedPayment({ authorizationId })
      if (auth.status === AuthorizationStatus.Voided) return { id: authorizationId, status: 'VOIDED' }
    } catch {
      // the re-read failed too: still unknown
    }
    throw unknownOutcome(cause)
  }

  // Runs one write. An answer that is missing what we depend on (run returns null) and a failure that left no usable
  // answer are both settled by `settle` (a re-read). A failure that never left (credential, encoding) and a definite
  // refusal are not: they are reported as they are.
  async function write(run, settle) {
    let result
    try {
      result = await run()
    } catch (err) {
      if (isUnknownWrite(err)) return settle(err)
      throw toPayPalError(err, { write: true })
    }
    return result === null ? settle() : result
  }

  return {
    createOrder(payee, { amountCents, memo, referenceId, returnUrl, cancelUrl, requestId }) {
      const client = clients.clientFor(payee)
      const body = {
        intent: CheckoutPaymentIntent.Authorize,
        purchaseUnits: [{
          referenceId,
          description: memo.slice(0, 120),
          amount: { currencyCode: 'USD', value: toValue(amountCents) },
        }],
        paymentSource: { paypal: { experienceContext: { returnUrl, cancelUrl, shippingPreference: PayPalWalletContextShippingPreference.NoShipping } } },
      }
      // No read-back operation finds an order by request id: an unknown outcome is settled by the lifecycle replaying
      // this call with the same PayPal-Request-Id, which PayPal answers with the original order.
      return write(async () => {
        const order = await client.orders.createOrder({ payPalRequestId: requestId, body }, ONCE)
        if (!order.id) return null
        return orderSchema.encode(order)
      }, (cause) => { throw unknownOutcome(cause) })
    },

    async getOrder(payee, orderId) {
      try {
        return await readOrder(clients.clientFor(payee), orderId)
      } catch (err) {
        throw toPayPalError(err, { write: false })
      }
    },

    authorizeOrder(payee, orderId, requestId) {
      const client = clients.clientFor(payee)
      return write(async () => {
        // return=representation: the lifecycle reads the authorization id from this answer.
        const res = await client.orders.authorizeOrder({ id: orderId, payPalRequestId: requestId, prefer: 'return=representation', body: {} }, ONCE)
        const order = orderAuthorizeResponseSchema.encode(res)
        return authorizationOf(order) ? order : null
      }, (cause) => settleAuthorize(client, orderId, cause))
    },

    captureAuthorization(payee, authorizationId, { amountCents, requestId, orderId }) {
      const client = clients.clientFor(payee)
      return write(async () => {
        const res = await client.payments.captureAuthorizedPayment({
          authorizationId,
          payPalRequestId: requestId,
          // The amount is computed by server code from the stored cents. final_capture closes the authorization.
          body: { amount: { currencyCode: 'USD', value: toValue(amountCents) }, finalCapture: true },
        }, ONCE)
        return res.id && res.status ? capturedPaymentSchema.encode(res) : null
      }, (cause) => settleCapture(client, orderId, cause))
    },

    voidAuthorization(payee, authorizationId, requestId) {
      const client = clients.clientFor(payee)
      return write(async () => {
        // return=representation: the SDK decodes the success body as JSON; return=minimal would be an empty body.
        await client.payments.voidPayment({ authorizationId, payPalRequestId: requestId, prefer: 'return=representation' }, ONCE)
        return { id: authorizationId, status: 'VOIDED' }
      }, (cause) => settleVoid(client, authorizationId, cause))
    },
  }
}
