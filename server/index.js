import { fileURLToPath } from 'node:url'
import { createServices } from './services.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { selectLlm } from './agent/selectLlm.js'
import { createPayeeRegistry } from './paypal/payees.js'
import { createHouseholdPool } from './households.js'

// Local mode: the mock PayPal delivers its signed webhooks to our own endpoint, like PayPal would.
export function wireMockWebhooks(svc) {
  svc.mock.setDeliver(async (payeeKey, _event, signed) => {
    await fetch(`${svc.config.publicUrl}/api/webhooks/paypal/${payeeKey}`, {
      method: 'POST',
      headers: { ...signed.headers, 'content-type': 'application/json' },
      body: signed.body,
    }).catch(() => {})
  })
}

export function start() {
  const config = loadConfig()
  // One live model client is shared; each visitor still gets a household (store, tokens, mock PayPal, scheduler) of their own.
  const llm = selectLlm(config)
  const pool = createHouseholdPool({
    build() {
      const svc = createServices({ config, llm })
      wireMockWebhooks(svc)
      const stop = svc.scheduler.start(1000)
      return { svc, dispose: stop }
    },
  })
  const app = createApp(pool)
  const server = app.listen(config.port, () => {
    const modes = createPayeeRegistry(config.env, undefined, { forceMock: config.forceMock }).list().map((p) => p.credentials.mode)
    process.stdout.write(`Second Look on ${config.publicUrl} (model: ${llm ? (llm.mode === 'account' ? 'Claude Sonnet (local account)' : 'live Claude') : 'scripted stand-in'}, PayPal: ${modes.includes('sandbox') ? 'sandbox' : 'local mock'})\n`)
  })
  return { pool, server }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start()
