import { PaypalClient } from 'paypal'

const SANDBOX_HOST = 'api-m.sandbox.paypal.com'
const ATTEMPT_TIMEOUT_MS = 15000

// The SDK declares one environment and has no selector, so the host is a base-URL override. Nothing in the options says
// which deployment this is, so the app states it here and refuses to start on anything but the sandbox host.
export function assertSandboxHost(apiBase) {
  let url
  try {
    url = new URL(apiBase)
  } catch {
    throw new Error('PAYPAL_API_BASE is not a valid URL')
  }
  if (url.protocol !== 'https:' || url.host !== SANDBOX_HOST) {
    throw new Error(`PAYPAL_API_BASE must be https://${SANDBOX_HOST}: this app only talks to the PayPal sandbox`)
  }
  return url.origin
}

// One PaypalClient per seller app, built once and kept for the process: the OAuth token cache lives on the client.
// fetchImpl is the SDK's single transport seam; tests pass a fake, production leaves it out (global fetch).
// retryOverride exists so tests can drop the read-retry waits; production passes nothing.
export function createSdkClients({ apiBase, fetchImpl, retryOverride = {} }) {
  const baseUrl = assertSandboxHost(apiBase)
  const clients = new Map()

  function buildClient(payee) {
    const { clientId, clientSecret } = payee.credentials
    // An unset credential is not an SDK error: the call would go out unauthenticated and fail later with a 401.
    if (!clientId || !clientSecret) throw new Error(`PayPal credentials for ${payee.key} are not configured`)
    return new PaypalClient({
      serverOptions: { baseUrl },
      oauth2: { clientId, clientSecret },
      // The default 60 s per attempt is too long for a family waiting on a screen.
      retry: { timeout: ATTEMPT_TIMEOUT_MS, ...retryOverride },
      // Off on purpose, so PAYPAL_CLIENT_LOG cannot switch it on. Request bodies carry memos and amounts.
      logging: { level: 'off' },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
  }

  return {
    clientFor(payee) {
      const id = payee.credentials.clientId
      if (!clients.has(id)) clients.set(id, buildClient(payee))
      return clients.get(id)
    },
  }
}
