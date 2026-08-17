import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RoomState } from '../hooks/useRoom'
import { leaveRoom, setRoomOptions, startGame } from '../lib/api'
import Screen from './Screen'

export default function Lobby({ state }: { state: RoomState }) {
  const { room, players, me } = state
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  if (!room || !me) return null

  const rounds = Math.floor(players.length / 2)
  const oddOneOut = players.length % 2 === 1

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setError(null)
    setBusy(true)
    try {
      await fn()
      after?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room!.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked -- the code is on screen anyway */
    }
  }

  return (
    <Screen>
      <div className="text-center">
        <p className="text-xs uppercase tracking-widest text-white/40">Room code</p>
        <button
          onClick={() => void copyCode()}
          className="mt-1 text-6xl font-black tracking-[0.15em] text-amber active:scale-95"
        >
          {room.code}
        </button>
        <p className="mt-2 text-sm text-white/40">
          {copied ? 'Copied!' : 'Tap to copy · others join with this code'}
        </p>
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">In the room</h2>
          <span className="text-sm text-white/40">{players.length}</span>
        </div>
        <ul className="mt-3 space-y-2">
          {players.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between rounded-xl bg-ink/60 px-4 py-3"
            >
              <span className="font-medium">
                {p.nickname}
                {p.id === me.id && <span className="ml-2 text-xs text-white/40">you</span>}
              </span>
              {p.is_owner && (
                <span className="rounded-full bg-amber/15 px-2 py-0.5 text-xs text-amber">host</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <button
        disabled={!me.is_owner || busy}
        onClick={() => void run(() => setRoomOptions(room.id, !room.mystery_themes))}
        className={`flex w-full items-center gap-4 rounded-3xl border p-5 text-left transition disabled:opacity-70 ${
          room.mystery_themes ? 'border-violet bg-violet/15' : 'border-ink-line bg-ink-soft/60'
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Mystery themes</div>
          <div className="mt-0.5 text-sm text-white/50">
            {room.mystery_themes
              ? 'Bets are placed blind — the theme is revealed when betting closes.'
              : 'Each duel’s theme is shown before you bet.'}
          </div>
        </div>
        <div
          className={`h-7 w-12 shrink-0 rounded-full p-1 transition ${
            room.mystery_themes ? 'bg-violet' : 'bg-ink-line'
          }`}
        >
          <div
            className={`h-5 w-5 rounded-full bg-white transition ${
              room.mystery_themes ? 'translate-x-5' : ''
            }`}
          />
        </div>
      </button>

      {players.length >= 2 && (
        <p className="text-center text-sm text-white/50">
          {rounds} {rounds === 1 ? 'duel' : 'duels'} ·{' '}
          {oddOneOut ? 'one player sits out and bets on every round' : 'everyone plays once'}
        </p>
      )}

      {me.is_owner ? (
        <button
          className="btn-primary"
          disabled={players.length < 2 || busy}
          onClick={() => void run(() => startGame(room.id))}
        >
          {players.length < 2 ? 'Waiting for players…' : busy ? 'Starting…' : 'Start the game'}
        </button>
      ) : (
        <p className="text-center text-white/50">Waiting for the host to start…</p>
      )}

      <button
        className="text-sm text-white/40 underline underline-offset-4"
        disabled={busy}
        onClick={() =>
          void run(
            () => leaveRoom(room.id),
            () => navigate('/'),
          )
        }
      >
        {me.is_owner ? 'Close this room' : 'Leave room'}
      </button>

      {error && (
        <p className="rounded-2xl bg-red-500/10 px-4 py-3 text-center text-sm text-red-300">
          {error}
        </p>
      )}
    </Screen>
  )
}
