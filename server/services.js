import { loadConfig } from './config.js'
import { systemClock } from './clock.js'
import { createLocks } from './lock.js'
import { createStore } from './store.js'
import { createPayeeRegistry } from './paypal/payees.js'
import { createGateway } from './paypal/gateway.js'
import { createMockPayPal } from './paypal/mock.js'
import { createInvestigator } from './agent/investigator.js'
import { createMockLlm } from './agent/mockLlm.js'
import { selectLlm } from './agent/selectLlm.js'
import { signalsFor } from './rules.js'
import { createLifecycle } from './payments/lifecycle.js'
import { createDecisions } from './payments/decisions.js'
import { createScheduler } from './payments/scheduler.js'
import { createWebhookHandler } from './payments/webhooks.js'

// Builds the whole backend. Tests pass a fake clock, a scripted model, a mock PayPal and short timers.
export function createServices(overrides = {}) {
  const config = overrides.config || loadConfig()
  const clock = overrides.clock || systemClock
  const timers = overrides.timers || config.timers
  const store = createStore()
  const registry = overrides.registry || createPayeeRegistry(config.env, undefined, { forceMock: config.forceMock })
  const mock = overrides.mock || createMockPayPal({ now: clock.now, publicUrl: config.publicUrl })
  const gateway = overrides.gateway || createGateway({ registry, apiBase: config.paypalApiBase, transport: config.paypalTransport, fetchImpl: overrides.fetchImpl, now: clock.now, publicUrl: config.publicUrl, mock })
  const llm = overrides.llm || selectLlm(config) || createMockLlm()
  const withLock = createLocks()

  const signalsOf = (payment) => signalsFor({ payment, payee: registry.get(payment.payeeKey), household: store.household() })
  const investigator = createInvestigator({ store, registry, gateway, llm, clock, wall: overrides.wall, timers, signalsOf })
  const lifecycle = createLifecycle({ store, registry, gateway, clock, timers, withLock, investigator, publicUrl: config.publicUrl })
  const decisions = createDecisions({ store, clock, timers, withLock, lifecycle, investigator })
  const scheduler = createScheduler({ store, clock, decisions, lifecycle })
  const webhooks = createWebhookHandler({ store, registry, gateway, clock, lifecycle })

  return { config, clock, timers, store, registry, mock: gateway.mock || mock, gateway, llm, investigator, lifecycle, decisions, scheduler, webhooks }
}
