import { isDeadlineError } from './loop.js'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const MAX_RUNS_KNOWN = 2000

export const RULES_LABEL = 'Rule-based stand-in'
const RECORDED_PREFIX = 'Recorded run'

// "Scripted stand-in" is the replay model's name for the rule-based fallback; the family sees the plain name.
const honestLabel = (source) => (!source || !source.startsWith(RECORDED_PREFIX) ? RULES_LABEL : source)

// Puts two protections around a live model: a cap per visitor address per hour and per host per day (one "run" is one
// investigation, counted once however many tool turns it takes), and a fallback that never shows an error.
// When a cap is reached or the live call fails, the same run continues on the fallback model (the recorded real run
// where one matches, the rule-based stand-in otherwise) and every answer carries a source label with the reason.
// The fallback only writes findings and report text. It cannot capture or release money, so a failed model never
// changes what happens to a held payment.
export function createLiveGuard({ live, fallback, perIpHour = 10, perDay = 150, now = () => Date.now() }) {
  const byIp = new Map() // ip -> start times inside the last hour
  let day = [] // start times inside the last 24 hours
  const runs = new Map() // run id -> { live: true } or { reason }

  function admit(ip) {
    const t = now()
    day = day.filter((at) => t - at < DAY)
    const recent = (byIp.get(ip) || []).filter((at) => t - at < HOUR)
    if (recent.length === 0) byIp.delete(ip)
    if (recent.length >= perIpHour) { byIp.set(ip, recent); return false }
    if (day.length >= perDay) { byIp.set(ip, recent); return false }
    byIp.set(ip, [...recent, t])
    day = [...day, t]
    return true
  }

  function decide(run) {
    const known = run?.id ? runs.get(run.id) : null
    if (known) return known
    const decision = admit(run?.ip || 'unknown') ? { live: true } : { reason: 'live limit reached' }
    if (run?.id) {
      if (runs.size >= MAX_RUNS_KNOWN) runs.delete(runs.keys().next().value)
      runs.set(run.id, decision)
    }
    return decision
  }

  async function viaFallback(args, reason) {
    const response = await fallback.step(args)
    return { ...response, source: `${honestLabel(response.source)} (${reason})` }
  }

  return {
    mode: live.mode,
    label: live.label,
    fallback,
    async step(args) {
      const decision = decide(args.run)
      if (!decision.live) return viaFallback(args, decision.reason)
      try {
        return await live.step(args)
      } catch (err) {
        const reason = isDeadlineError(err, args) ? 'live model timed out' : 'live model unavailable'
        if (args.run?.id) runs.set(args.run.id, { reason })
        return viaFallback(args, reason)
      }
    },
  }
}
