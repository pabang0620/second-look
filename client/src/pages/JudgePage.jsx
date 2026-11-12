import { useEffect, useState } from 'react'
import { bootstrap, judge } from '../api.js'
import { usePoll } from '../usePoll.js'
import { pinAfterScenario } from '../judgeLogic.js'
import ElderApp from '../components/ElderApp.jsx'
import FamilyApp from '../components/FamilyApp.jsx'
import PayPalPanel from '../components/PayPalPanel.jsx'

const paypalLabel = (list) => {
  const live = list.filter((p) => p.mode === 'sandbox').length
  return live === 0 ? 'local mode' : `sandbox for ${live} of ${list.length} sellers`
}

const panelNote = (panel) => (panel?.payeeMode === 'sandbox'
  ? 'PayPal sandbox (api-m.sandbox.paypal.com): these calls went to PayPal.'
  : 'Local mode uses a stand-in for PayPal with the same response shapes. See VERIFY.md for the sandbox run.')

// Judge mode: the payer and the family side by side, five scenario buttons, and PayPal's own state underneath.
export default function JudgePage() {
  const [boot, setBoot] = useState(null)
  const [error, setError] = useState('')
  const [pinnedId, setPinnedId] = useState(null) // the payment the payer picked; null = follow the open question, else the newest
  const [prefill, setPrefill] = useState(null) // scenario 5 sentence sent through the payer's own screen
  const { state, error: pollError, refresh } = usePoll(() => judge('GET', `/state${pinnedId ? `?paymentId=${pinnedId}` : ''}`), 1000, Boolean(boot))

  useEffect(() => { bootstrap().then(setBoot).catch((e) => setError(e.message)) }, [])
  useEffect(() => { if (boot) refresh() }, [pinnedId, refresh, boot])

  // The seller's message belongs to the payment shown on Margaret's phone (the PayPal panel follows the same payment).
  const shown = state?.elder.payments.find((p) => p.id === (pinnedId || state.elder.focusId))
  const seller = shown?.message ? shown.message.split(/(?<=[.!?])\s+/) : []

  const start = async (n) => {
    setError('')
    try {
      const info = boot.scenarios.find((s) => s.n === n)
      if (info.request) {
        // E4 and E5: the sentence goes through Margaret's screen and the elder API, like a pasted message.
        setPrefill({ key: Date.now(), text: info.request.text, amount: (info.request.amountCents / 100).toFixed(2), auto: true })
        return
      }
      const out = await judge('POST', '/scenario', { n })
      if (out.payment && !out.mockCheckout && out.payment.approveUrl) window.open(out.payment.approveUrl, '_blank', 'noopener')
      setPinnedId((cur) => pinAfterScenario(cur, out))
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }
  const reset = async () => { await judge('POST', '/reset'); setPinnedId(null); setPrefill(null); await refresh() }
  const t = boot?.timers

  return (
    <div className="judge">
      <header className="judge-head">
        <h1>Second Look <span className="small">judge mode</span></h1>
        <div className="scenarios" role="group" aria-label="Scenarios">
          {boot?.scenarios.map((s) => <button key={s.n} type="button" className="btn secondary" title={s.ends} onClick={() => start(s.n)}>{s.n} {s.title}</button>)}
          <button type="button" className="link" onClick={reset}>Reset</button>
        </div>
        <p className="small">{boot?.coverage} {t && <strong>Demo timer: {Math.round(t.autoVoidMs / 60000)} min (real: 70 h){`. Model: ${boot.modes.llmLabel}`}{`. PayPal: ${paypalLabel(boot.modes.paypal)}`}</strong>}</p>
        {(error || pollError) && <p className="banner" role="alert">{error || pollError}</p>}
      </header>
      <div className="judge-cols">
        <section className="col" aria-label="Margaret, the payer">
          <h2>MARGARET <span className="small">(payer)</span></h2>
          {seller.length > 0 && <div className="seller-msg" aria-label="Seller messages">{seller.map((m, i) => <p key={i}>{m}</p>)}</div>}
          <div className="phone"><ElderApp elder={state?.elder} refresh={refresh} pinnedId={pinnedId} onPin={setPinnedId} checkPrefill={prefill} onCheckDone={() => setPrefill(null)} /></div>
        </section>
        <section className="col" aria-label="Sarah, trusted family">
          <h2>SARAH <span className="small">(trusted family)</span></h2>
          <FamilyApp family={state?.family} refresh={refresh} judgeMode />
        </section>
      </div>
      <PayPalPanel panel={state?.panel} coverage={panelNote(state?.panel)} />
      <p className="small"><a href="/elder">Open the payer page alone</a> / <a href="/family">Open the family page alone</a></p>
    </div>
  )
}
