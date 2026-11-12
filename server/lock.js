// One async lock per key. Money actions on the same payment run one after another.
export function createLocks() {
  const tails = new Map()
  return function withLock(key, fn) {
    const previous = tails.get(key) || Promise.resolve()
    const run = previous.then(fn, fn)
    const tail = run.catch(() => {})
    tails.set(key, tail)
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}
