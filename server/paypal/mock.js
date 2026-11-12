import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { PayPalError } from './errors.js'
import { toValue } from '../money.js'

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
// Random per process, so nothing in the repository can forge a local-mode webhook.
const WEBHOOK_SIGNING_KEY = randomBytes(32).toString('hex')

function mockId(prefix = '', length = 17) {
  return prefix + Array.from(randomBytes(length), (b) => ALNUM[b % ALNUM.length]).join('')
}

export function signMockEvent(webhookId, transmissionId, time, body) {
  return createHmac('sha256', WEBHOOK_SIGNING_KEY).update(`${transmissionId}|${time}|${webhookId}|${body}`).digest('hex')
}

// A stand-in for PayPal with the same response shapes as the Orders and Payments v2 APIs.
// Orders and authorizations belong to the app (client id) that created them: another app gets PERMISSION_NOT_GRANTED.
export function createMockPayPal({ now = () => Date.now(), publicUrl = 'http://localhost:3001' } = {}) {
  const apps = new Map() // clientId -> { secret, payeeKey, merchantId, webhookId }
  const orders = new Map()
  const authorizations = new Map()
  const captures = new Map()
  const replays = new Map() // clientId|requestId -> stored result
  const log = [] // every call, replays included
  const faults = []
  const pending = [] // events waiting for delivery
  let deliver = null
  let autoFlush = true
  const iso = () => new Date(now()).toISOString()

  function register(payee) {
    apps.set(payee.credentials.clientId, { secret: payee.credentials.clientSecret, payeeKey: payee.key, merchantId: payee.merchantId, email: payee.email, webhookId: payee.credentials.webhookId })
  }

  function appOf(payee) {
    const app = apps.get(payee.credentials.clientId)
    if (!app || app.secret !== payee.credentials.clientSecret) throw new PayPalError(401, 'AUTHENTICATION_FAILURE', 'Client Authentication failed')
    return { clientId: payee.credentials.clientId, ...app }
  }

  function entry(op, app, requestId, replay, failed = false) {
    log.push({ at: iso(), op, payeeKey: app.payeeKey, requestId: requestId || null, replay: !!replay, failed })
  }

  function takeFault(op) {
    const idx = faults.findIndex((f) => f.op === op && f.times > 0)
    if (idx < 0) return null
    faults[idx] = { ...faults[idx], times: faults[idx].times - 1 }
    return faults[idx]
  }

  function emit(app, type, resource, related) {
    const event = {
      id: mockId('WH-', 14),
      event_version: '1.0',
      create_time: iso(),
      resource_type: type.split('.')[1].toLowerCase(),
      event_type: type,
      summary: type,
      resource: related ? { ...resource, supplementary_data: { related_ids: related } } : { ...resource }, // the real order event has no related_ids
    }
    pending.push({ payeeKey: app.payeeKey, event })
    if (deliver && autoFlush) setTimeout(() => flush().catch(() => {}), 150)
    return event
  }

  function owned(app, record, what) {
    if (!record) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', `${what} not found`)
    if (record.clientId !== app.clientId) {
      throw new PayPalError(403, 'PERMISSION_NOT_GRANTED', 'Payee of the authorization has not granted permission to perform capture on the authorization.')
    }
    return record
  }

  // Run once per Request-Id: the same key replays the first result (idempotency), failures included in the log.
  function idempotent(app, op, requestId, run) {
    const key = `${app.clientId}|${requestId}`
    if (requestId && replays.has(key)) {
      entry(op, app, requestId, true)
      const stored = replays.get(key)
      const fault = takeFault(op)
      if (fault) throw new PayPalError(503, 'SERVICE_UNAVAILABLE')
      return structuredClone(stored)
    }
    const fault = takeFault(op)
    entry(op, app, requestId, false, fault?.mode === '5xx')
    if (fault && fault.mode === '5xx') throw new PayPalError(503, 'SERVICE_UNAVAILABLE')
    let result
    try {
      result = run()
    } catch (err) {
      log[log.length - 1].failed = true
      throw err
    }
    if (requestId) replays.set(key, structuredClone(result))
    if (fault && fault.mode === '5xx_after_commit') throw new PayPalError(504, 'GATEWAY_TIMEOUT')
    return structuredClone(result)
  }

  function view(order) {
    const { clientId, ...rest } = order
    return structuredClone(rest)
  }

  const api = {
    register,
    log,
    // auto: deliver shortly after each event (server). Tests pass auto:false and call flush() themselves.
    setDeliver(fn, { auto = true } = {}) { deliver = fn; autoFlush = auto },
    // faults: { op: 'capture'|'void'|..., mode: '5xx'|'5xx_after_commit', times: n }
    injectFault(fault) { faults.push({ times: 1, ...fault }) },

    async createOrder(payee, { amountCents, memo, referenceId, returnUrl, cancelUrl, requestId }) {
      const app = appOf(payee)
      return idempotent(app, 'create_order', requestId, () => {
        const id = mockId('ORD')
        const order = {
          id, clientId: app.clientId, intent: 'AUTHORIZE', status: 'PAYER_ACTION_REQUIRED', create_time: iso(),
          purchase_units: [{ reference_id: referenceId, description: memo, amount: { currency_code: 'USD', value: toValue(amountCents) }, payee: { email_address: app.email, merchant_id: app.merchantId } }],
          links: [
            { rel: 'self', href: `mock://v2/checkout/orders/${id}`, method: 'GET' },
            { rel: 'payer-action', href: `${publicUrl}/mock-paypal/checkout?token=${id}`, method: 'GET' },
          ],
          _returnUrl: returnUrl,
          _cancelUrl: cancelUrl,
        }
        orders.set(id, order)
        const { _returnUrl, _cancelUrl, ...shape } = order
        return view(shape)
      })
    },

    async getOrder(payee, orderId) {
      const app = appOf(payee)
      entry('get_order', app, null, false)
      const order = owned(app, orders.get(orderId), 'Order')
      const { _returnUrl, _cancelUrl, ...shape } = order
      const out = view(shape)
      const unit = out.purchase_units[0]
      if (unit.payments?.authorizations?.length) {
        const auth = authorizations.get(unit.payments.authorizations[0].id)
        unit.payments.authorizations[0].status = auth.status
        const done = [...captures.values()].filter((c) => c.authorizationId === auth.id).map(({ clientId, authorizationId, ...c }) => c)
        if (done.length) unit.payments.captures = done
      }
      return out
    },

    async authorizeOrder(payee, orderId, requestId) {
      const app = appOf(payee)
      return idempotent(app, 'authorize', requestId, () => {
        const order = owned(app, orders.get(orderId), 'Order')
        if (order.status !== 'APPROVED') throw new PayPalError(422, 'ORDER_NOT_APPROVED', 'Order is not approved by the payer')
        const unit = order.purchase_units[0]
        const auth = { id: mockId('AUTH'), clientId: app.clientId, orderId, status: 'CREATED', amount: { ...unit.amount }, create_time: iso(), expiration_time: new Date(now() + 29 * 86400000).toISOString() }
        authorizations.set(auth.id, auth)
        order.status = 'COMPLETED'
        unit.payments = { authorizations: [{ id: auth.id, status: 'CREATED', amount: auth.amount, create_time: auth.create_time, expiration_time: auth.expiration_time }] }
        emit(app, 'PAYMENT.AUTHORIZATION.CREATED', { id: auth.id, status: 'CREATED', amount: auth.amount }, { order_id: orderId, authorization_id: auth.id })
        const { _returnUrl, _cancelUrl, ...shape } = order
        return view(shape)
      })
    },

    async captureAuthorization(payee, authorizationId, { amountCents, requestId }) {
      const app = appOf(payee)
      return idempotent(app, 'capture', requestId, () => {
        const auth = owned(app, authorizations.get(authorizationId), 'Authorization')
        if (auth.status !== 'CREATED') throw new PayPalError(422, 'AUTHORIZATION_ALREADY_COMPLETED', `Authorization is ${auth.status}`)
        if (toValue(amountCents) !== auth.amount.value) throw new PayPalError(422, 'MAX_CAPTURE_AMOUNT_EXCEEDED', 'Amount must equal the authorization')
        const capture = { id: mockId('CAP'), status: 'COMPLETED', amount: { ...auth.amount }, final_capture: true, create_time: iso() }
        captures.set(capture.id, { ...capture, clientId: app.clientId, authorizationId })
        auth.status = 'CAPTURED'
        emit(app, 'PAYMENT.CAPTURE.COMPLETED', capture, { order_id: auth.orderId, authorization_id: authorizationId })
        return capture
      })
    },

    async voidAuthorization(payee, authorizationId, requestId) {
      const app = appOf(payee)
      return idempotent(app, 'void', requestId, () => {
        const auth = owned(app, authorizations.get(authorizationId), 'Authorization')
        if (auth.status !== 'CREATED') throw new PayPalError(422, 'AUTHORIZATION_ALREADY_COMPLETED', `Authorization is ${auth.status}`)
        auth.status = 'VOIDED'
        emit(app, 'PAYMENT.AUTHORIZATION.VOIDED', { id: authorizationId, status: 'VOIDED' }, { order_id: auth.orderId, authorization_id: authorizationId })
        return { id: authorizationId, status: 'VOIDED' }
      })
    },

    async verifyWebhook(payee, { headers, event }) {
      const app = appOf(payee)
      const expected = signMockEvent(app.webhookId, headers['paypal-transmission-id'] || '', headers['paypal-transmission-time'] || '', JSON.stringify(event))
      const given = String(headers['paypal-transmission-sig'] || '')
      const ok = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
      return ok ? 'SUCCESS' : 'FAILURE'
    },

    // ----- Mock-only: what the buyer and the seller do inside PayPal's own screens -----
    buyerApprove(orderId) {
      const order = orders.get(orderId)
      if (!order) return null
      if (order.status === 'PAYER_ACTION_REQUIRED') {
        order.status = 'APPROVED'
        const app = apps.get(order.clientId)
        emit({ payeeKey: app.payeeKey }, 'CHECKOUT.ORDER.APPROVED', { id: orderId, status: 'APPROVED' }, null)
      }
      return { returnUrl: order._returnUrl, cancelUrl: order._cancelUrl }
    },
    peekOrder: (orderId) => (orders.has(orderId) ? view((({ _returnUrl, _cancelUrl, ...r }) => r)(orders.get(orderId))) : null),
    peekAuthorization: (id) => (authorizations.has(id) ? structuredClone((({ clientId, ...r }) => r)(authorizations.get(id))) : null),
    // A real seller refunding a captured payment in their own PayPal dashboard.
    sellerRefund(captureId) {
      const capture = captures.get(captureId)
      if (!capture) throw new PayPalError(404, 'RESOURCE_NOT_FOUND')
      const app = apps.get(capture.clientId)
      const refund = { id: mockId('REF'), status: 'COMPLETED', amount: capture.amount, create_time: iso() }
      const auth = authorizations.get(capture.authorizationId)
      emit({ payeeKey: app.payeeKey }, 'PAYMENT.CAPTURE.REFUNDED', refund, { order_id: auth.orderId, authorization_id: auth.id, capture_id: captureId })
      return refund
    },
    operationCount: (op) => log.filter((l) => l.op === op && !l.replay && !l.failed).length,
    callCount: (op) => log.filter((l) => l.op === op).length,

    // Deliver queued events as signed webhooks. Tests call this by hand; the server calls it on a short delay.
    async flush() { return flush() },
    pendingEvents: () => pending.map((p) => p.event),
    signedDelivery(payeeKey, event) {
      const app = [...apps.values()].find((a) => a.payeeKey === payeeKey)
      const transmissionId = mockId('TX', 12)
      const time = iso()
      const body = JSON.stringify(event)
      return {
        body,
        headers: {
          'paypal-transmission-id': transmissionId,
          'paypal-transmission-time': time,
          'paypal-transmission-sig': signMockEvent(app.webhookId, transmissionId, time, body),
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'mock://cert',
        },
      }
    },
  }

  async function flush() {
    const batch = pending.splice(0, pending.length)
    for (const item of batch) {
      if (deliver) await deliver(item.payeeKey, item.event, api.signedDelivery(item.payeeKey, item.event))
    }
    return batch.length
  }

  return api
}
