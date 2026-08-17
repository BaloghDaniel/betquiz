import { useEffect, useState } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { ensureSignedIn } from './lib/supabase'
import Home from './routes/Home'
import RoomView from './routes/RoomView'
import Screen from './components/Screen'

// HashRouter rather than BrowserRouter: GitHub Pages has no SPA rewrite, so a
// refresh on /room/abc would 404. The hash never reaches the server.
export default function App() {
  const [userId, setUserId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ensureSignedIn()
      .then(setUserId)
      .catch((e: Error) => setError(e.message))
  }, [])

  if (error) {
    return (
      <Screen>
        <div className="card">
          <h1 className="text-xl font-bold text-amber">Could not sign in</h1>
          <p className="mt-2 text-sm text-white/70">{error}</p>
          <p className="mt-4 text-sm text-white/50">
            If this says anonymous sign-ins are disabled, enable them in the Supabase
            dashboard under Authentication → Sign In / Providers → Anonymous sign-ins.
          </p>
        </div>
      </Screen>
    )
  }

  if (!userId) {
    return (
      <Screen>
        <p className="text-center text-white/50">Connecting…</p>
      </Screen>
    )
  }

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:roomId" element={<RoomView userId={userId} />} />
      </Routes>
    </HashRouter>
  )
}
