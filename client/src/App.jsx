import JudgePage from './pages/JudgePage.jsx'
import ElderPage from './pages/ElderPage.jsx'
import FamilyPage from './pages/FamilyPage.jsx'
import ReturnPage from './pages/ReturnPage.jsx'

// Four routes, read from the path. No router library is needed.
export default function App() {
  const path = window.location.pathname
  if (path.startsWith('/elder')) return <ElderPage />
  if (path.startsWith('/family')) return <FamilyPage />
  if (path.startsWith('/return')) return <ReturnPage />
  return <JudgePage />
}
