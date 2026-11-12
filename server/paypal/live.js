import { PayPalError } from './errors.js'
import { toValue } from '../money.js'

// Real PayPal REST calls. Every call runs with the credentials of one payee; tokens are cached per client id.
// The fetch function is injected so tests can prove the calls without touching the network.
export function createLivePayPal({ apiBase, fetchImpl = fetch, now = () => Date.now() }) {
  const tokens = new Map()

  async function accessToken(payee) {
    const { clientId, clientSecret } = payee.credentials
    const cached = tokens.get(clientId)
    if (cached && now() < cached.expires - 60000) return cached.value
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const res = await fetchImpl(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }).catch(() => { throw new PayPalError(0, 'NETWORK', 'PayPal did not answer') })
    if (!res.ok) throw new PayPalError(res.status, 'AUTH_FAILED', `PayPal oauth failed for ${payee.key} (${res.status})`)
    const data = await res.json()
    tokens.set(clientId, { value: data.access_token, expires: now() + data.expires_in * 1000 })
    return data.access_token
  }

  async function call(payee, method, path, body, requestId) {
    const headers = { Authorization: `Bearer ${await accessToken(payee)}`, 'Content-Type': 'application/json' }
    if (requestId) headers['PayPal-Request-Id'] = requestId
    const res = await fetchImpl(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .catch(() => { throw new PayPalError(0, 'NETWORK', 'PayPal did not answer') })
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    if (!res.ok) throw new PayPalError(res.status, data.details?.[0]?.issue || data.name || 'ERROR', data.message)
    return data
  }

  return {
    createOrder: (payee, { amountCents, memo, referenceId, returnUrl, cancelUrl, requestId }) =>
      call(payee, 'POST', '/v2/checkout/orders', {
        intent: 'AUTHORIZE',
        purchase_units: [{ reference_id: referenceId, description: memo.slice(0, 120), amount: { currency_code: 'USD', value: toValue(amountCents) } }],
        payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING' } } },
      }, requestId),
    getOrder: (payee, orderId) => call(payee, 'GET', `/v2/checkout/orders/${orderId}`),
    authorizeOrder: (payee, orderId, requestId) => call(payee, 'POST', `/v2/checkout/orders/${orderId}/authorize`, {}, requestId),
    captureAuthorization: (payee, authorizationId, { amountCents, requestId }) =>
      call(payee, 'POST', `/v2/payments/authorizations/${authorizationId}/capture`, { amount: { currency_code: 'USD', value: toValue(amountCents) }, final_capture: true }, requestId),
    voidAuthorization: async (payee, authorizationId, requestId) => {
      await call(payee, 'POST', `/v2/payments/authorizations/${authorizationId}/void`, undefined, requestId)
      return { id: authorizationId, status: 'VOIDED' }
    },
    // The webhook belongs to one app, so it is verified with that payee's own credentials and webhook id.
    verifyWebhook: async (payee, { headers, event }) => {
      const result = await call(payee, 'POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: payee.credentials.webhookId,
        webhook_event: event,
      })
      return result.verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE'
    },
  }
}
