import { useCallback, useEffect, useRef, useState } from 'react'

// Re-reads a state endpoint every second. refresh() reads it right now (after a click).
// enabled=false waits (for example until the session exists) before the first read.
export function usePoll(load, intervalMs = 1000, enabled = true) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const loadRef = useRef(load)
  loadRef.current = load

  const refresh = useCallback(async () => {
    try {
      setState(await loadRef.current())
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    const tick = async () => { if (alive) await refresh() }
    tick()
    const timer = setInterval(tick, intervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [refresh, intervalMs, enabled])

  return { state, error, refresh }
}

export const clock = (seconds) => {
  if (seconds === null || seconds === undefined) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}
