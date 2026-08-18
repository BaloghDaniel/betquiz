import { useEffect, useState } from 'react'
import type { RoomState } from '../hooks/useRoom'
import type { Match, MatchResults } from '../lib/types'
import { getMatchResults, nextRound } from '../lib/api'
import Screen from './Screen'
import DevRoundPicker from './DevRoundPicker'

export default function RoundResult({ state, match }: { state: RoomState; match: Match }) {
  const { room, me, matches, players } = state
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
      <Screen home>
        <p className="text-center text-ink/60">{error ?? 'Tallying up…'}</p>
      </Screen>
    )
  }

  const isLast = match.match_index === matches.length - 1
  const winner = res.is_draw ? null : res.winner_id === res.p1.id ? res.p1 : res.p2
  const myDrink = res.drinks.filter((d) => d.player === me.nickname)
  const myTotal = myDrink.reduce((s, d) => s + d.mouthfuls, 0)

  // One card per person who drinks. A player can only owe for one reason in a
  // round -- duellists are barred from betting on their own duel -- but this
  // totals per player rather than relying on that.
  const drinkers = Object.values(
    res.drinks.reduce<Record<string, { name: string; mouthfuls: number; reasons: string[] }>>(
      (acc, d) => {
        acc[d.player] ??= { name: d.player, mouthfuls: 0, reasons: [] }
        acc[d.player].mouthfuls += d.mouthfuls
        acc[d.player].reasons.push(d.reason)
        return acc
      },
      {},
    ),
  ).sort((a, b) => b.mouthfuls - a.mouthfuls)

  // "lost their bet" is true but vague; naming who they backed explains it.
  const why = (player: string, reason: string) => {
    if (reason === 'quiz_loss') return 'lost the duel'
    const bet = res.bets.find((b) => b.bettor === player && !b.won)
    return bet ? `backed ${bet.backed}` : 'lost the bet'
  }

  const safe = players
    .filter((p) => !drinkers.some((d) => d.name === p.nickname))
    .map((p) => p.nickname)

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
      home
      header={
        <div className="pt-2 text-center text-xs uppercase tracking-widest text-ink/50">
          Duel {match.match_index + 1} of {matches.length} · result
        </div>
      }
    >
      <div className="text-center">
        {res.is_draw ? (
          <>
            <h1 className="text-3xl font-black text-ink/85">Dead heat</h1>
            <p className="mt-2 text-ink/60">All bets are void. Nobody drinks. Suspicious.</p>
          </>
        ) : (
          <>
            <p className="text-sm uppercase tracking-widest text-ink/50">Winner</p>
            <h1 className="mt-1 text-4xl font-black text-accent-deep">{winner?.nickname}</h1>
          </>
        )}
        <p className="mt-3 text-2xl font-bold tabular-nums">
          {res.p1.nickname} {res.p1_score} – {res.p2_score} {res.p2.nickname}
        </p>
      </div>

      {/* The payoff: what this player personally owes, impossible to miss. */}
      <div
        className={`rounded-3xl p-5 text-center ${
          myTotal > 0 ? 'bg-coral text-ink' : 'border border-line bg-surface'
        }`}
      >
        {/* No opacity on the labels here. Coral is the darkest of the bright
            fills, so ink on it is 4.69:1 with nothing to spare -- fading these
            to 70% drops them to 3.3. Size and weight carry the hierarchy. */}
        {myTotal > 0 ? (
          <>
            <div className="text-xs font-semibold uppercase tracking-widest">
              You drink
            </div>
            <div className="text-6xl font-black">{myTotal}</div>
            <div className="mt-1 font-semibold">
              {myTotal === 1 ? 'mouthful' : 'mouthfuls'}
            </div>
            <div className="mt-1 text-sm">
              {myDrink.map((d) => (d.reason === 'quiz_loss' ? 'lost the duel' : 'lost your bet')).join(' + ')}
            </div>
          </>
        ) : (
          <div className="font-semibold text-mint-deep">You’re safe — nothing to drink.</div>
        )}
      </div>

      {drinkers.length === 0 && !res.is_draw && (
        <p className="text-center text-mint-deep">Nobody drinks this round.</p>
      )}

      {drinkers.length > 0 && (
        <div>
          <h2 className="mb-2 text-center text-xs uppercase tracking-widest text-ink/50">
            Who’s drinking
          </h2>

          <div className="space-y-2">
            {drinkers.map((d) => {
              const isMe = d.name === me.nickname
              return (
                <div
                  key={d.name}
                  className={`flex items-center gap-4 rounded-2xl border p-4 ${
                    isMe ? 'border-coral bg-coral/15' : 'border-line bg-surface'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-lg font-bold">
                      {d.name}
                      {isMe && <span className="ml-2 text-xs font-medium text-ink/60">you</span>}
                    </div>
                    <div className="mt-0.5 text-sm text-ink/60">
                      {d.reasons.map((r) => why(d.name, r)).join(' + ')}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="text-4xl leading-none font-black text-coral-deep tabular-nums">
                      {d.mouthfuls}
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-wider text-ink/50">
                      {d.mouthfuls === 1 ? 'mouthful' : 'mouthfuls'}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Naming who is safe makes the list unambiguous -- otherwise a
              missing name reads as an oversight rather than good luck. */}
          {safe.length > 0 && (
            <p className="mt-3 text-center text-sm text-ink/60">
              <span className="text-mint-deep">Drinking nothing:</span> {safe.join(', ')}
            </p>
          )}
        </div>
      )}

      {res.bets.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-ink/70">Bets</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {res.bets.map((b, i) => (
              <li key={i} className="flex justify-between">
                <span className="text-ink/85">
                  {b.bettor} → {b.backed} ({b.amount})
                </span>
                <span className={b.won ? 'text-mint-deep' : 'text-coral-deep'}>
                  {res.is_draw ? 'void' : b.won ? 'won' : 'lost'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        className="text-sm text-ink/50 underline underline-offset-4"
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
              <p className="mt-2 text-sm text-mint-deep">{q.options[q.correct_index]}</p>
              <p className="mt-1 text-xs text-ink/50">
                {res.p1.nickname}: {q.p1_selected === null ? 'no answer' : q.options[q.p1_selected]}{' '}
                {q.p1_selected === q.correct_index ? '✓' : '✗'} · {res.p2.nickname}:{' '}
                {q.p2_selected === null ? 'no answer' : q.options[q.p2_selected]}{' '}
                {q.p2_selected === q.correct_index ? '✓' : '✗'}
              </p>
            </div>
          ))}
        </div>
      )}

      {room.is_dev ? (
        <>
          <DevRoundPicker roomId={room.id} label="Next round" />
          <button
            className="text-sm text-ink/50 underline underline-offset-4"
            disabled={busy}
            onClick={() => void go()}
          >
            {busy ? 'Loading…' : 'End the game and see the leaderboard'}
          </button>
        </>
      ) : me.is_owner ? (
        <button className="btn-primary" disabled={busy} onClick={() => void go()}>
          {busy ? 'Loading…' : isLast ? 'See the final results' : 'Next duel'}
        </button>
      ) : (
        <p className="text-center text-sm text-ink/50">
          Waiting for the host to {isLast ? 'close the game' : 'start the next duel'}…
        </p>
      )}

      {error && (
        <p className="rounded-2xl bg-coral/10 px-4 py-3 text-center text-sm text-coral-deep">
          {error}
        </p>
      )}
    </Screen>
  )
}
