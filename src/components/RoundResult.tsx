import { useEffect, useState } from 'react'
import type { RoomState } from '../hooks/useRoom'
import type { Match, MatchResults } from '../lib/types'
import { getMatchResults, nextRound } from '../lib/api'
import Screen from './Screen'

export default function RoundResult({ state, match }: { state: RoomState; match: Match }) {
  const { room, me, matches } = state
  const [res, setRes] = useState<MatchResults | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getMatchResults(match.id)
      .then(setRes)
      .catch((e: Error) => setError(e.message))
  }, [match.id])

  if (!room || !me) return null
  if (!res) {
    return (
      <Screen>
        <p className="text-center text-white/50">{error ?? 'Tallying up…'}</p>
      </Screen>
    )
  }

  const isLast = match.match_index === matches.length - 1
  const winner = res.is_draw ? null : res.winner_id === res.p1.id ? res.p1 : res.p2
  const myDrink = res.drinks.filter((d) => d.player === me.nickname)
  const myTotal = myDrink.reduce((s, d) => s + d.mouthfuls, 0)

  async function go() {
    setError(null)
    setBusy(true)
    try {
      await nextRound(room!.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      header={
        <div className="pt-2 text-center text-xs uppercase tracking-widest text-white/40">
          Duel {match.match_index + 1} of {matches.length} · result
        </div>
      }
    >
      <div className="text-center">
        {res.is_draw ? (
          <>
            <h1 className="text-3xl font-black text-white/80">Dead heat</h1>
            <p className="mt-2 text-white/50">All bets are void. Nobody drinks. Suspicious.</p>
          </>
        ) : (
          <>
            <p className="text-sm uppercase tracking-widest text-white/40">Winner</p>
            <h1 className="mt-1 text-4xl font-black text-amber">{winner?.nickname}</h1>
          </>
        )}
        <p className="mt-3 text-2xl font-bold tabular-nums">
          {res.p1.nickname} {res.p1_score} – {res.p2_score} {res.p2.nickname}
        </p>
      </div>

      {/* The payoff: what this player personally owes, impossible to miss. */}
      <div
        className={`rounded-3xl p-5 text-center ${
          myTotal > 0 ? 'bg-amber text-ink' : 'border border-ink-line bg-ink-soft/60'
        }`}
      >
        {myTotal > 0 ? (
          <>
            <div className="text-6xl font-black">{myTotal}</div>
            <div className="mt-1 font-semibold">
              {myTotal === 1 ? 'mouthful' : 'mouthfuls'} — drink up
            </div>
            <div className="mt-1 text-sm opacity-70">
              {myDrink.map((d) => (d.reason === 'quiz_loss' ? 'lost the duel' : 'lost your bet')).join(' + ')}
            </div>
          </>
        ) : (
          <div className="font-semibold text-emerald-300">You drink nothing this round.</div>
        )}
      </div>

      {res.drinks.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-white/60">Everyone owes</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {res.drinks.map((d, i) => (
              <li key={i} className="flex justify-between">
                <span className="text-white/80">{d.player}</span>
                <span className="text-white/50">
                  {d.mouthfuls} · {d.reason === 'quiz_loss' ? 'lost the duel' : 'lost their bet'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {res.bets.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-white/60">Bets</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {res.bets.map((b, i) => (
              <li key={i} className="flex justify-between">
                <span className="text-white/80">
                  {b.bettor} → {b.backed} ({b.amount})
                </span>
                <span className={b.won ? 'text-emerald-300' : 'text-red-300'}>
                  {res.is_draw ? 'void' : b.won ? 'won' : 'lost'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        className="text-sm text-white/40 underline underline-offset-4"
        onClick={() => setShowReview((v) => !v)}
      >
        {showReview ? 'Hide the questions' : 'Review the questions'}
      </button>

      {showReview && (
        <div className="space-y-3">
          {res.questions.map((q) => (
            <div key={q.position} className="card">
              <p className="text-sm font-medium">
                {q.position + 1}. {q.prompt}
              </p>
              <p className="mt-2 text-sm text-emerald-300">{q.options[q.correct_index]}</p>
              <p className="mt-1 text-xs text-white/40">
                {res.p1.nickname}: {q.p1_selected === null ? 'no answer' : q.options[q.p1_selected]}{' '}
                {q.p1_selected === q.correct_index ? '✓' : '✗'} · {res.p2.nickname}:{' '}
                {q.p2_selected === null ? 'no answer' : q.options[q.p2_selected]}{' '}
                {q.p2_selected === q.correct_index ? '✓' : '✗'}
              </p>
            </div>
          ))}
        </div>
      )}

      {me.is_owner ? (
        <button className="btn-primary" disabled={busy} onClick={() => void go()}>
          {busy ? 'Loading…' : isLast ? 'See the final results' : 'Next duel'}
        </button>
      ) : (
        <p className="text-center text-sm text-white/40">
          Waiting for the host to {isLast ? 'close the game' : 'start the next duel'}…
        </p>
      )}

      {error && (
        <p className="rounded-2xl bg-red-500/10 px-4 py-3 text-center text-sm text-red-300">
          {error}
        </p>
      )}
    </Screen>
  )
}
