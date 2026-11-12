import { useState } from 'react'
import { call } from '../api.js'
import Icon from './Icon.jsx'

export default function PayForm({ payees, trusted, onCreated }) {
  const known = payees.filter((p) => trusted.includes(p.key))
  const fresh = payees.filter((p) => !trusted.includes(p.key))
  const [choice, setChoice] = useState(known[0]?.key || '')
  const [newKey, setNewKey] = useState(fresh[0]?.key || '')
  const [someoneNew, setSomeoneNew] = useState(false)
  const [amount, setAmount] = useState('20')
  const [memo, setMemo] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const created = await call('elder', 'POST', '/api/elder/payments', { payeeKey: someoneNew ? newKey : choice, amount, memo, message })
      setMemo('')
      setMessage('')
      onCreated(created)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="screen" onSubmit={submit}>
      <h2>Who are you paying?</h2>
      <fieldset className="choices">
        <legend className="sr">Seller</legend>
        {known.map((p) => (
          <label key={p.key} className="choice"><input type="radio" name="payee" checked={!someoneNew && choice === p.key} onChange={() => { setSomeoneNew(false); setChoice(p.key) }} /> {p.displayName} <span className="tag"><Icon name="check" />known</span></label>
        ))}
        <label className="choice"><input type="radio" name="payee" checked={someoneNew} onChange={() => setSomeoneNew(true)} /> Someone new</label>
      </fieldset>
      {someoneNew && (
        <label className="field">Which seller
          <select value={newKey} onChange={(e) => setNewKey(e.target.value)}>{fresh.map((p) => <option key={p.key} value={p.key}>{p.displayName}</option>)}</select>
        </label>
      )}
      <label className="field">Amount in dollars<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field">What is it for?<input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="for example, a scooter" required /></label>
      <label className="field">Paste their message (optional)<textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
      {error && <p className="banner" role="alert">{error}</p>}
      <button type="submit" className="btn" disabled={busy}>Continue to PayPal</button>
    </form>
  )
}
