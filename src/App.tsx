import { useEffect, useState } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { ensureSignedIn } from './lib/supabase'
import Home from './routes/Home'
import RoomView from './routes/RoomView'
import Screen from './components/Screen'
import ErrorBoundary from './components/ErrorBoundary'

// HashRouter rather than BrowserRouter: GitHub Pages has no SPA rewrite, so a
// refresh on /room/abc would 404. The hash never reaches the server.
//
// The router wraps *everything*, including the connecting and error states.
// Screen uses useNavigate() for its "back to start" link, and a component that
// calls it outside Router context throws during render -- which unmounts the
// whole tree and leaves nothing but the body background. Keeping the provider
// at the very top means no screen can ever be rendered without it.
export default function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </ErrorBoundary>
  )
}

function AppRoutes() {
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
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/room/:roomId" element={<RoomView userId={userId} />} />
    </Routes>
  )
}
