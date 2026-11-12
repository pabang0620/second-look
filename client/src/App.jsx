import { useEffect, useState } from 'react'
import { bootstrap } from './api.js'
import JudgePage from './pages/JudgePage.jsx'
import ElderPage from './pages/ElderPage.jsx'
import FamilyPage from './pages/FamilyPage.jsx'
import ReturnPage from './pages/ReturnPage.jsx'

// Four routes, read from the path. No router library is needed.
export default function App() {
  const path = window.location.pathname
  if (path.startsWith('/family')) return <FamilyPage />
  if (path.startsWith('/return')) return <ReturnPage />
  return <PaymentView payerOnly={path.startsWith('/elder')} />
}

// Both payer entry points use the same bootstrap and retry only that read.
function PaymentView({ payerOnly }) {
  const [boot, setBoot] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    bootstrap().then(
      (data) => { if (active) setBoot(data) },
      (err) => { if (active) setError(err.message || 'Connection failed.') },
    )
    return () => { active = false }
  }, [attempt])
  if (boot) return payerOnly ? <ElderPage boot={boot} /> : <JudgePage boot={boot} />
  return (
    <main className="solo">
      <div className="phone solo-phone"><div className="phone-body">
        {error ? <>
          <p className="banner" role="alert">Could not load your payments.</p>
          <button type="button" className="btn primary" onClick={() => { setError(''); setAttempt((n) => n + 1) }}>Try again</button>
        </> : <p role="status">Loading your payments...</p>}
      </div></div>
    </main>
  )
}
