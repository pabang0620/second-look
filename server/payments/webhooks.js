import { HttpError } from '../http.js'
import { STATES } from '../store.js'

// Webhooks confirm PayPal-side facts next to the API responses. Every event is signature-verified with the receiving
// payee's own app, de-duplicated by event id (recorded only after it was processed), and can only move a payment
// forward, never back.
export function createWebhookHandler({ store, registry, gateway, clock, lifecycle }) {
  // CHECKOUT.ORDER.* events carry the order itself (resource.id is the order id), PAYMENT.AUTHORIZATION.* carry the
  // authorization, PAYMENT.CAPTURE.* carry the capture plus related ids. Match on all of them.
  function findPayment(event) {
    const resource = event.resource || {}
    const related = resource.supplementary_data?.related_ids || {}
    const type = String(event.event_type || '')
    const id = typeof resource.id === 'string' ? resource.id : null
    const payments = store.list()
    return payments.find((p) => related.order_id && p.orderId === related.order_id)
      || payments.find((p) => related.authorization_id && p.authorizationId === related.authorization_id)
      || (type.startsWith('CHECKOUT.ORDER.') && id ? payments.find((p) => p.orderId === id) : null)
      || (type.startsWith('PAYMENT.AUTHORIZATION.') && id ? payments.find((p) => p.authorizationId === id) : null)
      || (type.startsWith('PAYMENT.CAPTURE.') && id ? payments.find((p) => p.captureId === id) : null)
      || null
  }

  // A signature made by the local stand-in must never be accepted for a seller that uses the real sandbox.
  const isMockSigned = (headers) => String(headers?.['paypal-cert-url'] || '').startsWith('mock://')

  async function handle({ payeeKey, headers, event }) {
    const payee = registry.get(payeeKey)
    if (!payee) throw new HttpError(404, 'Unknown webhook target')
    let verification = 'FAILURE'
    try {
      const closed = payee.credentials.mode === 'sandbox' && (!payee.credentials.webhookId || isMockSigned(headers))
      verification = closed ? 'FAILURE' : await gateway.verifyWebhook(payee, { headers, event })
    } catch {
      verification = 'FAILURE'
    }
    if (verification !== 'SUCCESS') {
      store.log({ at: clock.now(), kind: 'webhook_rejected', payeeKey, eventId: String(event?.id || '') })
      throw new HttpError(401, 'Webhook signature could not be verified')
    }
    if (store.hasEvent(event.id)) return { duplicate: true }

    const payment = findPayment(event)
    if (!payment) {
      store.markEvent(event.id)
      return { duplicate: false, matched: false }
    }

    switch (event.event_type) {
      case 'CHECKOUT.ORDER.APPROVED':
        await lifecycle.ensureAuthorized(payment.id)
        break
      case 'PAYMENT.AUTHORIZATION.VOIDED':
        lifecycle.applyFact(payment.id, { type: 'voided' })
        break
      case 'PAYMENT.CAPTURE.COMPLETED':
        lifecycle.applyFact(payment.id, { type: 'captured', captureId: event.resource.id })
        break
      case 'PAYMENT.CAPTURE.DENIED':
        store.transition(payment.id, [STATES.CAPTURING, STATES.APPROVED_PENDING], STATES.FAILED, { failure: 'PayPal declined the capture. Nothing was charged.' })
        break
      case 'PAYMENT.CAPTURE.REFUNDED':
        if (store.get(payment.id).state === STATES.CAPTURED) {
          store.update(payment.id, { refunded: true, refundedAt: clock.now() })
          store.log({ at: clock.now(), kind: 'refunded', paymentId: payment.id })
        }
        break
      default:
        break // PAYMENT.AUTHORIZATION.CREATED and others are recorded below and change nothing
    }
    // Recorded last: if processing threw, PayPal's redelivery of this event is processed again.
    if (!store.markEvent(event.id)) return { duplicate: true } // a parallel delivery finished first
    const entry = { id: event.id, type: event.event_type, at: clock.now(), verification }
    store.update(payment.id, (p) => ({ webhooks: [...p.webhooks, entry].slice(-30) }))
    return { duplicate: false, matched: true }
  }

  return { handle, matches: (event) => Boolean(findPayment(event || {})) }
}
