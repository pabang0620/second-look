import { call } from '../api.js'
import { usePoll } from '../usePoll.js'
import FamilyApp from '../components/FamilyApp.jsx'

export default function FamilyPage() {
  const { state, error, refresh } = usePoll(() => call('family', 'GET', '/api/family/state'))
  return (
    <main className="solo">
      {error && <p className="banner" role="alert">{error}</p>}
      <FamilyApp family={state} refresh={refresh} />
      <p className="solo-link"><a href="/">Judge mode</a></p>
    </main>
  )
}
