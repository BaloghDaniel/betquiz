import { useState } from 'react'
import { devStartRound } from '../lib/api'

/**
 * Sandbox control: pick whether the next duel is yours to play or to bet on.
 *
 * With three players (you plus two bots) the pairing follows directly from the
 * choice -- "I play" pairs you with a bot and leaves the other to bet on you,
 * "I bet" pairs the two bots and leaves you betting. Flipping between the two
 * covers both sides of the game solo.
 */
export default function DevRoundPicker({
  roomId,
  label = 'Start a round',
}: {
  roomId: string
  label?: string
}) {
  const [busy, setBusy] = useState<'play' | 'bet' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function go(mode: 'play' | 'bet') {
    setError(null)
    setBusy(mode)
    try {
      await devStartRound(roomId, mode)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-3xl border border-accent/40 bg-accent/10 p-4">
      <div className="text-center text-xs uppercase tracking-widest text-ink/60">
        Sandbox · {label}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <button
          disabled={busy !== null}
          onClick={() => void go('play')}
          className="rounded-2xl bg-accent px-3 py-4 font-bold text-ink transition active:scale-[0.98] disabled:opacity-40"
        >
          {busy === 'play' ? '…' : 'I play'}
          <div className="mt-0.5 text-[11px] font-medium">
            you vs a bot
          </div>
        </button>
        <button
          disabled={busy !== null}
          onClick={() => void go('bet')}
          className="rounded-2xl bg-mint px-3 py-4 font-bold text-ink transition active:scale-[0.98] disabled:opacity-40"
        >
          {busy === 'bet' ? '…' : 'I bet'}
          <div className="mt-0.5 text-[11px] font-medium">
            bot vs bot
          </div>
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-2xl bg-coral/10 px-4 py-2 text-center text-sm text-coral-deep">
          {error}
        </p>
      )}
    </div>
  )
}
