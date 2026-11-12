import { createLivePayPal } from './live.js'
import { createMockPayPal } from './mock.js'
import { createSdkClients } from './sdkClient.js'
import { createSdkLive } from './sdkLive.js'

// One gateway for the app. A payee with real sandbox credentials goes to PayPal; a payee without goes to the mock.
// Either way the call carries that payee's own credentials, so nothing is shared between sellers.
// Orders and Payments calls go through the APIMatic PayPal SDK (transport 'sdk', the default). Webhook verification is
// not in the SDK and stays on REST. PAYPAL_TRANSPORT=rest switches the Orders and Payments calls back to the REST adapter.
export function createGateway({ registry, apiBase, fetchImpl, now, publicUrl, transport = 'sdk', sdkRetry, mock = createMockPayPal({ now, publicUrl }) }) {
  const rest = createLivePayPal({ apiBase, fetchImpl, now })
  const liveSellers = registry.list().filter((payee) => payee.credentials.mode === 'sandbox')
  let live = rest
  if (transport === 'sdk' && liveSellers.length > 0) {
    const clients = createSdkClients({ apiBase, fetchImpl, retryOverride: sdkRetry })
    // Built now, not on the first call: a wrong host or a blank credential stops the app at startup.
    for (const payee of liveSellers) clients.clientFor(payee)
    live = createSdkLive({ clients })
  }
  for (const payee of registry.list()) {
    if (payee.credentials.mode === 'mock') mock.register(payee)
  }
  const pick = (payee) => (payee.credentials.mode === 'sandbox' ? live : mock)
  return {
    mock,
    createOrder: (payee, args) => pick(payee).createOrder(payee, args),
    getOrder: (payee, orderId) => pick(payee).getOrder(payee, orderId),
    authorizeOrder: (payee, orderId, requestId) => pick(payee).authorizeOrder(payee, orderId, requestId),
    captureAuthorization: (payee, authorizationId, args) => pick(payee).captureAuthorization(payee, authorizationId, args),
    voidAuthorization: (payee, authorizationId, requestId) => pick(payee).voidAuthorization(payee, authorizationId, requestId),
    verifyWebhook: (payee, args) => (payee.credentials.mode === 'sandbox' ? rest : mock).verifyWebhook(payee, args),
  }
}

export const approvalLink = (order) => order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href || null
export const authorizationOf = (order) => order?.purchase_units?.[0]?.payments?.authorizations?.[0] || null
export const captureOf = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0] || null
