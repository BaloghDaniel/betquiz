import { useCallback, useEffect, useRef, useState } from 'react'
import type { RoomState } from '../hooks/useRoom'
import type { LiveQuestion, Match } from '../lib/types'
import { advanceMatch, getCurrentQuestion, submitAnswer } from '../lib/api'
import Screen from './Screen'

const POLL_MS = 700

export default function Quiz({ state, match }: { state: RoomState; match: Match }) {
  const { room, players, me, refresh } = state
  const [q, setQ] = useState<LiveQuestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const skew = useRef(0)
  const lastAdvance = useRef(0)
  const lastPosition = useRef<number>(-1)

  const name = (id: string) => players.find((p) => p.id === id)?.nickname ?? '—'

  const poll = useCallback(async () => {
    try {
      const next = await getCurrentQuestion(match.id)
      // Trust the server's clock, not the phone's.
      if (next.server_now) skew.current = Date.now() - new Date(next.server_now).getTime()
      setQ(next)
      setError(null)

      if (next.status === 'finished') {
        refresh()
        return
      }

      if (next.position !== lastPosition.current) {
        if (lastPosition.current !== -1 && next.is_duellist) navigator.vibrate?.(30)
        lastPosition.current = next.position
        setPending(null)
      }

      // Any client may pump the state machine -- advance_match is idempotent and
      // validates its own preconditions. Doing it from every device means the
      // game keeps moving even if the host's phone falls asleep.
      const expired = Date.now() - skew.current > new Date(next.deadline).getTime()
      const bothIn = next.p1_answered && next.p2_answered
      if ((bothIn || expired) && Date.now() - lastAdvance.current > 800) {
        lastAdvance.current = Date.now()
        await advanceMatch(match.id)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [match.id, refresh])

  useEffect(() => {
    void poll()
    const id = setInterval(() => void poll(), POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  // Countdown ticks locally so the bar is smooth between polls.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [])

  if (!room || !me) return null

  if (!q || q.status === 'finished' || !q.prompt) {
    return (
      <Screen>
        <p className="text-center text-white/50">Scoring the duel…</p>
      </Screen>
    )
  }

  const total = room.question_seconds * 1000
  const remaining = Math.max(0, new Date(q.deadline).getTime() - (now - skew.current))
  const frac = Math.max(0, Math.min(1, remaining / total))
  const seconds = Math.ceil(remaining / 1000)

  const myChoice = q.my_answer?.selected_index ?? pending
  const answered = myChoice !== null && myChoice !== undefined

  async function answer(i: number) {
    if (!q?.is_duellist || answered) return
    setPending(i)
    try {
      await submitAnswer(q.match_question_id, i)
      void poll()
    } catch (e) {
      setPending(null)
      setError((e as Error).message)
    }
  }

  return (
    <Screen
      header={
        <div className="pt-2">
          <div className="flex items-center justify-between text-xs uppercase tracking-widest text-white/40">
            <span>
              Question {q.position + 1} / {q.total}
            </span>
            <span className="font-semibold text-amber">{q.category}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-line">
            <div
              className={`h-full transition-[width] duration-100 ease-linear ${
                frac < 0.25 ? 'bg-red-400' : 'bg-amber'
              }`}
              style={{ width: `${frac * 100}%` }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className={q.p1_answered ? 'text-emerald-300' : 'text-white/40'}>
              {name(match.player1_id)} {q.p1_answered ? '✓' : '…'}
            </span>
            <span className="font-bold text-white/70">
              {q.p1_score} – {q.p2_score}
            </span>
            <span className={q.p2_answered ? 'text-emerald-300' : 'text-white/40'}>
              {q.p2_answered ? '✓' : '…'} {name(match.player2_id)}
            </span>
          </div>
        </div>
      }
    >
      {q.previous && (
        <div className="rounded-2xl border border-ink-line bg-ink-soft/40 px-4 py-2 text-xs text-white/50">
          Q{q.previous.position + 1} answer:{' '}
          <span className="text-white/80">{q.previous.options[q.previous.correct_index]}</span>
          <span className="ml-2">
            {name(match.player1_id)} {q.previous.p1_correct ? '✓' : '✗'} ·{' '}
            {name(match.player2_id)} {q.previous.p2_correct ? '✓' : '✗'}
          </span>
        </div>
      )}

      <div className="text-center">
        <div className="text-5xl font-black tabular-nums text-white/80">{seconds}</div>
        <h1 className="mt-4 text-xl leading-snug font-bold">{q.prompt}</h1>
      </div>

      <div className="space-y-3">
        {q.options.map((opt, i) => {
          const chosen = myChoice === i
          return (
            <button
              key={i}
              disabled={!q.is_duellist || answered}
              onClick={() => void answer(i)}
              className={`w-full rounded-2xl border-2 px-5 py-4 text-left text-lg transition active:scale-[0.99] disabled:active:scale-100 ${
                chosen
                  ? 'border-amber bg-amber/20 text-white'
                  : 'border-ink-line bg-ink-soft/60 text-white/90'
              } ${!q.is_duellist ? 'opacity-70' : ''}`}
            >
              <span className="mr-3 text-white/30">{'ABCD'[i]}</span>
              {opt}
            </button>
          )
        })}
      </div>

      {!q.is_duellist ? (
        <p className="text-center text-sm text-white/50">
          You’re watching this one — no shouting the answers.
        </p>
      ) : answered ? (
        <p className="text-center text-sm text-emerald-300">
          Locked in. Waiting for your opponent…
        </p>
      ) : (
        <p className="text-center text-sm text-white/40">Pick fast — ties are broken on time.</p>
      )}

      {error && (
        <p className="rounded-2xl bg-red-500/10 px-4 py-3 text-center text-sm text-red-300">
          {error}
        </p>
      )}
    </Screen>
  )
}
