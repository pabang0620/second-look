import { useEffect, useState } from 'react'
import { bootstrap, call, judge } from '../api.js'
import { clock } from '../usePoll.js'
import PayForm from './PayForm.jsx'
import CheckRequest from './CheckRequest.jsx'

const ACTIVE = ['CREATED', 'HELD', 'HELD_ASKING', 'APPROVED_PENDING', 'CAPTURING', 'VOIDING']

const STATE_LABEL = {
  CREATED: 'Waiting for your approval in PayPal', HELD: 'Waiting for a quick check', HELD_ASKING: 'Needs your answer', APPROVED_PENDING: 'Approved',
  CAPTURING: 'Being paid', VOIDING: 'Being cancelled', CAPTURED: 'Paid', VOIDED: 'Cancelled', FAILED: 'Not completed',
}

// The payer's phone. One decision per screen, big text, plain words.
// The screen shows the payment the payer picked, else the one with an open question, else the newest. Other payments
// stay in a short list underneath, so a question is never hidden by a newer payment.
export default function ElderApp({ elder, refresh, pinnedId = null, onPin = () => {}, checkPrefill = null, onCheckDone = () => {} }) {
  const [boot, setBoot] = useState(null)
  const [mode, setMode] = useState('auto') // auto | pay | check
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { bootstrap().then(setBoot).catch((e) => setError(e.message)) }, [])
  useEffect(() => { if (checkPrefill) setMode('check') }, [checkPrefill])

  if (!elder || !boot) return <div className="phone-body"><p>Loading...</p></div>
  const focus = elder.payments.find((p) => p.id === (pinnedId || elder.focusId)) || elder.payments.find((p) => p.id === elder.focusId) || elder.payments[0]
  const others = elder.payments.filter((p) => p !== focus)
  const showPayment = mode === 'auto' && focus
  const closeCheck = () => { onCheckDone(); setMode('auto') }
  const run = async (fn) => {
    setBusy(true)
    setError('')
    try { await fn(); await refresh() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const mockMode = focus && boot.payees.find((p) => p.key === focus.payeeKey)?.mode === 'mock'

  return (
    <div className="phone-body">
      <header className="phone-head"><span>Hi {elder.household.elderName}</span></header>
      {error && <p className="banner" role="alert">{error}</p>}
      {mode === 'check' && <CheckRequest key={checkPrefill?.key || 'manual'} elder={elder} initial={checkPrefill} onDone={refresh} onBack={closeCheck} />}
      {mode === 'pay' && <PayForm payees={boot.payees} trusted={elder.household.trustedPayees} onCreated={(created) => { onPin(created.id); setMode('auto'); refresh() }} />}
      {mode === 'auto' && !showPayment && <PayForm payees={boot.payees} trusted={elder.household.trustedPayees} onCreated={(created) => { onPin(created.id); refresh() }} />}
      {showPayment && <PaymentScreen p={focus} run={run} busy={busy} mockMode={mockMode} elder={elder} onNew={() => { onPin(null); setMode('pay') }} />}
      {mode === 'auto' && others.length > 0 && <OtherPayments items={others} onShow={onPin} />}
      <footer className="phone-foot">
        <button type="button" className="link" onClick={() => setMode('check')}>Someone asked me for money without PayPal</button>
        <RulesRow elder={elder} run={run} />
      </footer>
    </div>
  )
}

function OtherPayments({ items, onShow }) {
  return (
    <section className="others" aria-label="Your other payments">
      <h3>Your other payments</h3>
      <ul>
        {items.slice(0, 4).map((p) => (
          <li key={p.id} className={p.question ? 'needs-answer' : ''}>
            <span>{p.payeeName} {p.amount}<br /><span className="small">{p.question ? 'One quick question is waiting' : STATE_LABEL[p.state]}</span></span>
            <button type="button" className="btn secondary" onClick={() => onShow(p.id)}>{p.question ? 'Answer' : 'Show'}</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RulesRow({ elder, run }) {
  const h = elder.household
  if (h.rulesState === 'RULES_OFF') return <p className="small">Checks are off. {h.familyName} can turn them back on.</p>
  if (h.rulesState === 'PAUSE_REQUESTED') {
    return <p className="small">Checks turn off in 24 hours. {h.familyName} has been told. <button type="button" className="link" onClick={() => run(() => call('elder', 'POST', '/api/elder/rules/cancel-pause'))}>Cancel</button></p>
  }
  return <p className="small"><button type="button" className="link" onClick={() => run(() => call('elder', 'POST', '/api/elder/rules/pause'))}>Turn checks off (takes 24 hours)</button></p>
}

function PaymentScreen({ p, run, busy, mockMode, elder, onNew }) {
  const done = !ACTIVE.includes(p.state)
  return (
    <section className="screen" aria-live="polite">
      <p className="seller">{p.payeeName} <strong>{p.amount}</strong></p>
      {p.state === 'CREATED' && <ApproveStep p={p} run={run} busy={busy} mockMode={mockMode} />}
      {(p.state === 'HELD' || (p.state === 'HELD_ASKING' && !p.question)) && <Waiting p={p} />}
      {p.state === 'HELD_ASKING' && p.question && <Question p={p} run={run} busy={busy} />}
      {p.state === 'APPROVED_PENDING' && <><h2>{elder.household.familyName} said yes</h2><p>PayPal will take the payment in {clock(p.undoSecondsLeft)}.</p></>}
      {(p.state === 'CAPTURING' || p.state === 'VOIDING') && <h2>One moment...</h2>}
      {p.state === 'CAPTURED' && <Paid p={p} />}
      {p.state === 'VOIDED' && <Stopped p={p} run={run} busy={busy} />}
      {p.state === 'FAILED' && <><h2>Not completed</h2><p>{p.failure}</p></>}
      {done && <button type="button" className="btn secondary" onClick={onNew}>New payment</button>}
    </section>
  )
}

function ApproveStep({ p, run, busy, mockMode }) {
  return (
    <>
      <h2>Approve in PayPal</h2>
      <p>PayPal will ask you to approve this payment. Nothing is charged by approving.</p>
      {mockMode
        ? <button type="button" className="btn" disabled={busy} onClick={() => run(() => judge('POST', '/mock-approve', { paymentId: p.id }))}>Approve in PayPal (local mode)</button>
        : <a className="btn" href={p.approveUrl} target="_blank" rel="noreferrer">Continue to PayPal</a>}
    </>
  )
}

function Waiting({ p }) {
  return (
    <>
      <h2>Waiting for a quick check</h2>
      <p>{p.waitingMessage}</p>
      {p.secondsToAutoVoid !== null && <p className="timer" aria-label="time left">{clock(p.secondsToAutoVoid)} left</p>}
      {p.secondRequest && <p className="small">This is your second request for this seller.</p>}
    </>
  )
}

function Question({ p, run, busy }) {
  return (
    <>
      <h2>One quick question</h2>
      <p>{p.question.text}</p>
      <div className="stack">
        {p.question.options.map((choice) => (
          <button key={choice} type="button" className="btn secondary" disabled={busy} onClick={() => run(() => call('elder', 'POST', `/api/elder/payments/${p.id}/answer`, { choice }))}>{choice}</button>
        ))}
      </div>
    </>
  )
}

function Paid({ p }) {
  return (
    <>
      <h2>Paid</h2>
      <p>{p.amount} went to {p.payeeName}.</p>
      {p.receipt && <p className="small">Receipt {p.receipt.captureId}</p>}
    </>
  )
}

function Stopped({ p, run, busy }) {
  const reason = p.stopReason
  return (
    <>
      <h2>{p.expired ? 'This payment was cancelled' : p.stopReason ? `${p.familyName} stopped this payment` : 'Payment cancelled'}</h2>
      {reason && <p>Why: {reason}.</p>}
      {p.expired && <p>Nobody answered in time, so PayPal released the hold.</p>}
      <p><strong>Nothing was charged.</strong></p>
      {p.familyPhone && <p><a className="btn secondary" href={`tel:${p.familyPhone.replace(/[^\d+]/g, '')}`}>Call {p.familyName}: {p.familyPhone}</a></p>}
      {p.canAskAgain && !p.expired && <button type="button" className="btn" disabled={busy} onClick={() => run(() => call('elder', 'POST', `/api/elder/payments/${p.id}/ask-again`))}>Ask again</button>}
      {!p.canAskAgain && !p.expired && <p className="small">Ask {p.familyName} to trust this seller before trying again.</p>}
    </>
  )
}
