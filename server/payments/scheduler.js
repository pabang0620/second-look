import { STATES, HELD_STATES } from '../store.js'

// All timed behavior lives in tick(). The server calls it every second; tests call it with a fake clock.
const PICKUP_EVERY_MS = 10 * 1000
const PICKUP_WINDOW_MS = 30 * 60 * 1000

export function createScheduler({ store, clock, decisions, lifecycle }) {
  let running = null
  const lastPickup = new Map()

  async function tick() {
    const now = clock.now()
    const household = store.household()
    if (household.rulesState === 'PAUSE_REQUESTED' && now >= household.pauseEffectiveAt) {
      store.updateHousehold({ rulesState: 'RULES_OFF' })
      store.log({ at: now, kind: 'rules_off' })
    }
    for (const p of store.list()) {
      if (p.state === STATES.CREATED && p.orderId && now - p.createdAt <= PICKUP_WINDOW_MS && now - (lastPickup.get(p.id) ?? 0) >= PICKUP_EVERY_MS) {
        // The payer approved at PayPal but we never heard (window closed, event lost): look at the order ourselves.
        lastPickup.set(p.id, now)
        await lifecycle.pickUpApproved(p.id)
      } else if (HELD_STATES.includes(p.state) && now >= p.voidAt) {
        await decisions.autoVoid(p.id)
      } else if (p.state === STATES.HELD_ASKING && now >= p.askExpiresAt) {
        // Nobody answered the question: continue with "No answer". It never counts as a reason to lower risk.
        try { decisions.answer(p.id, 'No answer', { system: true }) } catch { /* answered a moment ago */ }
      } else if (p.state === STATES.APPROVED_PENDING && now >= p.captureAt) {
        await decisions.captureDue(p.id)
      } else if (p.state === STATES.CAPTURING || p.state === STATES.VOIDING) {
        await decisions.retryStuck(p.id)
      }
    }
  }

  return {
    tick,
    start(intervalMs = 1000) {
      const timer = setInterval(() => {
        if (running) return
        running = tick().catch((err) => process.stderr.write(`tick failed: ${err?.stack || err}\n`)).finally(() => { running = null })
      }, intervalMs)
      timer.unref()
      return () => clearInterval(timer)
    },
  }
}
