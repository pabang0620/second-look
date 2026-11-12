export const systemClock = { now: () => Date.now() }

// Test clock: time only moves when the test says so.
export function fakeClock(start = Date.UTC(2026, 10, 12, 9, 0, 0)) {
  let t = start
  return {
    now: () => t,
    set: (value) => { t = value },
    advance: (ms) => { t += ms },
  }
}
