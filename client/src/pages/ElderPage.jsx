import { useState } from 'react'
import { call } from '../api.js'
import { usePoll } from '../usePoll.js'
import ElderApp from '../components/ElderApp.jsx'

export default function ElderPage() {
  const [pinnedId, setPinnedId] = useState(null)
  const { state, error, refresh } = usePoll(() => call('elder', 'GET', '/api/elder/state'))
  return (
    <main className="solo">
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="phone solo-phone"><ElderApp elder={state} refresh={refresh} pinnedId={pinnedId} onPin={setPinnedId} /></div>
      <p className="solo-link"><a href="/">Judge mode</a></p>
    </main>
  )
}
