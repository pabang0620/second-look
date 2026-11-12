import { useEffect, useState } from 'react'

// What the payer sees after PayPal sends her back. The wording follows what really happened to the payment,
// which the server puts in the address (outcome=captured | held | waiting | failed).
const COPY = {
  captured: { title: 'Payment sent', body: 'Your payment went through. It is to a seller your family already trusts, so no extra check was needed.' },
  held: { title: 'Back from PayPal', body: 'Your approval was received. Nothing has been charged yet. Your family is taking a quick look first.' },
  waiting: { title: 'Back from PayPal', body: 'We have not heard from PayPal yet. Nothing has been charged. Second Look keeps checking for a few minutes.' },
  failed: { title: 'Not completed', body: 'PayPal could not finish this payment. Nothing was charged.' },
  cancelled: { title: 'Cancelled', body: 'Nothing was charged.' },
}

export default function ReturnPage() {
  const params = new URLSearchParams(window.location.search)
  const key = params.get('cancelled') ? 'cancelled' : (COPY[params.get('outcome')] ? params.get('outcome') : 'held')
  const copy = COPY[key]
  const [stillOpen, setStillOpen] = useState(false)

  // A window the app opened can close itself. If the browser refuses, the page stays and says so.
  useEffect(() => {
    const closeTimer = setTimeout(() => window.close(), 1500)
    const hintTimer = setTimeout(() => setStillOpen(true), 2200)
    return () => { clearTimeout(closeTimer); clearTimeout(hintTimer) }
  }, [])

  return (
    <main className="return-page">
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      <p><button type="button" className="btn secondary" onClick={() => window.close()}>Close this window</button></p>
      {stillOpen && <p className="small">If this window stays open, close it yourself and go back to Second Look.</p>}
      <p><a className="btn" href="/">Go back to Second Look</a></p>
    </main>
  )
}
