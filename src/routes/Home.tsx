import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createRoom, joinRoom } from '../lib/api'
import Screen from '../components/Screen'

const NICK_KEY = 'betquiz.nickname'
const LAST_ROOM = 'betquiz.lastRoom'

export default function Home() {
  const navigate = useNavigate()
  const [nickname, setNickname] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'create' | 'join' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<{ id: string; code: string } | null>(null)

  useEffect(() => {
    setNickname(localStorage.getItem(NICK_KEY) ?? '')
    const raw = localStorage.getItem(LAST_ROOM)
    if (raw) {
      try {
        setLast(JSON.parse(raw) as { id: string; code: string })
      } catch {
        localStorage.removeItem(LAST_ROOM)
      }
    }
  }, [])

  async function go(action: 'create' | 'join') {
    setError(null)
    setBusy(action)
    try {
      localStorage.setItem(NICK_KEY, nickname.trim())
      const res =
        action === 'create'
          ? await createRoom(nickname.trim())
          : await joinRoom(code.trim(), nickname.trim())
      localStorage.setItem(LAST_ROOM, JSON.stringify({ id: res.room_id, code: res.code }))
      navigate(`/room/${res.room_id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const nameOk = nickname.trim().length > 0

  return (
    <Screen>
      <div className="text-center">
        <h1 className="text-5xl font-black tracking-tight">
          Bet<span className="text-amber">Quiz</span>
        </h1>
        <p className="mt-3 text-white/60">
          Two players duel over 10 questions. Everyone else bets mouthfuls on the winner.
        </p>
      </div>

      <input
        className="field mt-4"
        placeholder="Your name"
        value={nickname}
        maxLength={20}
        autoComplete="off"
        onChange={(e) => setNickname(e.target.value)}
      />

      <button
        className="btn-primary"
        disabled={!nameOk || busy !== null}
        onClick={() => void go('create')}
      >
        {busy === 'create' ? 'Creating…' : 'Create a room'}
      </button>

      <div className="flex items-center gap-3 py-1 text-xs uppercase tracking-widest text-white/30">
        <div className="h-px flex-1 bg-ink-line" />
        or join one
        <div className="h-px flex-1 bg-ink-line" />
      </div>

      <input
        className="field text-center text-2xl font-bold tracking-[0.3em] uppercase"
        placeholder="CODE"
        value={code}
        maxLength={6}
        autoCapitalize="characters"
        autoComplete="off"
        onChange={(e) => setCode(e.target.value.toUpperCase())}
      />

      <button
        className="btn-ghost"
        disabled={!nameOk || code.trim().length < 4 || busy !== null}
        onClick={() => void go('join')}
      >
        {busy === 'join' ? 'Joining…' : 'Join room'}
      </button>

      {last && (
        <button
          className="text-sm text-white/40 underline underline-offset-4"
          onClick={() => navigate(`/room/${last.id}`)}
        >
          Rejoin {last.code}
        </button>
      )}

      {error && (
        <p className="rounded-2xl bg-red-500/10 px-4 py-3 text-center text-sm text-red-300">
          {error}
        </p>
      )}
    </Screen>
  )
}
