import { useEffect, useRef, useState } from 'react'
import { call } from '../api.js'
import Icon from './Icon.jsx'

// E4 and E5: no money, only a sentence. Claude checks it and the family is told.
// `initial` ({ text, amount }) comes from the Judge scenario 5 button: the sentence is filled in and sent through this
// same screen, so the payer's phone shows E4 and E5 exactly as it would for a pasted message.
export default function CheckRequest({ elder, onDone, onBack, initial }) {
  const [text, setText] = useState(initial?.text || '')
  const [amount, setAmount] = useState(initial?.amount || '')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const sent = useRef(false)
  const send = async (body) => {
    setBusy(true)
    setError('')
    try {
      setResult(await call('elder', 'POST', '/api/elder/requests', body))
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  const submit = (event) => {
    event.preventDefault()
    return send({ text, ...(amount ? { amount } : {}) })
  }

  useEffect(() => {
    if (initial?.auto && !sent.current) {
      sent.current = true
      send({ text: initial.text, ...(initial.amount ? { amount: initial.amount } : {}) })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (result) {
    return (
      <section className="screen">
        <p className="status stop"><Icon name="alert" />Do not send money yet.</p>
        <h2>What we noticed</h2>
        <ul className="found">
          {result.findings.map((f, i) => <li key={i}><Icon name="alert" /><span><strong>{f.kind.charAt(0).toUpperCase() + f.kind.slice(1).replace(/_/g, ' ')}</strong>: "{f.quote}"</span></li>)}
          {result.findings.length === 0 && <li><Icon name="info" /><span>Nothing specific, but please check with {elder.household.familyName}.</span></li>}
        </ul>
        <p>{result.report?.elderMessage}</p>
        <p><a className="btn" href={`tel:${elder.household.familyPhone.replace(/[^\d+]/g, '')}`}><Icon name="phone" />Call {elder.household.familyName}</a></p>
        <button type="button" className="btn secondary" onClick={onBack}>Done</button>
      </section>
    )
  }
  return (
    <form className="screen" onSubmit={submit}>
      <h2>Someone asked you for money without PayPal?</h2>
      <label className="field">Paste or type what they said<textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} required minLength={3} /></label>
      <label className="field">How much? (optional)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      {error && <p className="banner" role="alert">{error}</p>}
      <button type="submit" className="btn" disabled={busy}>Check this</button>
      <button type="button" className="btn secondary" onClick={onBack}>Back</button>
    </form>
  )
}
