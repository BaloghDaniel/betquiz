import { useCallback, useEffect, useRef, useState } from 'react'
import type { RoomState } from '../hooks/useRoom'
import type { LiveQuestion, Match } from '../lib/types'
import { advanceMatch, getCurrentQuestion, submitAnswer } from '../lib/api'
import Screen from './Screen'
import ThemeReveal from './ThemeReveal'

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

  // Derived as plain booleans rather than passing `players` into poll's deps:
  // the roster is a fresh array on every refetch, which would rebuild poll and
  // restart the interval each time.
  const p1IsBot = players.some((p) => p.id === match.player1_id && p.is_bot)
  const p2IsBot = players.some((p) => p.id === match.player2_id && p.is_bot)

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

      // Nothing to pump while the theme reveal is on screen: no question has
      // started, so there is nothing to advance past.
      if (next.revealing) return

      // Any client may pump the state machine -- advance_match is idempotent and
      // validates its own preconditions. Doing it from every device means the
      // game keeps moving even if the host's phone falls asleep.
      const expired =
        !!next.deadline && Date.now() - skew.current > new Date(next.deadline).getTime()
      const bothIn = next.p1_answered && next.p2_answered

      // A bot only gets to answer when advance_match runs, because that is what
      // calls bq_bot_answers. Waiting for bothIn/expired would deadlock: the bot
      // cannot answer until we call, and we would not call until it answered --
      // so every question ran its full timer. Keep pumping while a bot is in the
      // duel and still owes an answer.
      const botOwesAnswer =
        (p1IsBot && !next.p1_answered) || (p2IsBot && !next.p2_answered)

      if ((bothIn || expired || botOwesAnswer) && Date.now() - lastAdvance.current > 800) {
        lastAdvance.current = Date.now()
        await advanceMatch(match.id)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [match.id, refresh, p1IsBot, p2IsBot])

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

  // The reveal ends on a server timestamp, but the question only arrives on the
  // next poll. Fetch the instant the window closes so the first question is not
  // left waiting behind a finished animation.
  const revealEnded = useRef(false)
  useEffect(() => {
    if (!q?.revealing || !q.reveal_until) {
      revealEnded.current = false
      return
    }
    const left = new Date(q.reveal_until).getTime() - (Date.now() - skew.current)
    if (left <= 0 && !revealEnded.current) {
      revealEnded.current = true
      void poll()
    }
  }, [now, q, poll])

  if (!room || !me) return null

  // The theme reveal: checked before the "no prompt" guard below, because the
  // server deliberately withholds the prompt for the whole reveal window.
  if (q?.revealing && q.reveal_until) {
    const revealTotal = room.reveal_seconds * 1000
    const revealLeft = Math.max(0, new Date(q.reveal_until).getTime() - (now - skew.current))
    return (
      <ThemeReveal
        candidates={q.candidates}
        category={q.category}
        msLeft={revealLeft}
        totalMs={revealTotal}
        bets={state.bets}
        players={players}
        match={match}
        isDuellist={q.is_duellist}
      />
    )
  }

  if (!q || q.status === 'finished' || !q.prompt) {
    return (
      <Screen home>
        <p className="text-center text-ink/60">Scoring the duel…</p>
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
      home
      header={
        <div className="pt-2">
          <div className="flex items-center justify-between text-xs uppercase tracking-widest text-ink/50">
            <span>
              Question {q.position + 1} / {q.total}
            </span>
            <span className="font-semibold text-accent-deep">{q.category}</span>
          </div>
          {/* The deep variants, not the bright fills: a mid-luminance cyan on a
              light track is only 2.1:1, and darkening the track makes it worse,
              not better. A 1.5px bar has to clear 3:1 to be seen at all. */}
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className={`h-full transition-[width] duration-100 ease-linear ${
                frac < 0.25 ? 'bg-coral-deep' : 'bg-accent-deep'
              }`}
              style={{ width: `${frac * 100}%` }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className={q.p1_answered ? 'text-mint-deep' : 'text-ink/50'}>
              {name(match.player1_id)} {q.p1_answered ? '✓' : '…'}
            </span>
            <span className="font-bold text-ink/75">
              {q.p1_score} – {q.p2_score}
            </span>
            <span className={q.p2_answered ? 'text-mint-deep' : 'text-ink/50'}>
              {q.p2_answered ? '✓' : '…'} {name(match.player2_id)}
            </span>
          </div>
        </div>
      }
    >
      {q.previous && (
        <div className="rounded-2xl border border-line bg-surface px-4 py-2 text-xs text-ink/60">
          Q{q.previous.position + 1} answer:{' '}
          <span className="text-ink/85">{q.previous.options[q.previous.correct_index]}</span>
          <span className="ml-2">
            {name(match.player1_id)} {q.previous.p1_correct ? '✓' : '✗'} ·{' '}
            {name(match.player2_id)} {q.previous.p2_correct ? '✓' : '✗'}
          </span>
        </div>
      )}

      <div className="text-center">
        <div className="text-5xl font-black tabular-nums text-ink/85">{seconds}</div>
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
                  ? 'border-accent bg-accent/20 text-ink'
                  : 'border-line bg-surface text-ink/90'
              } ${!q.is_duellist ? 'opacity-70' : ''}`}
            >
              <span className="mr-3 text-ink/40">{'ABCD'[i]}</span>
              {opt}
            </button>
          )
        })}
      </div>

      {!q.is_duellist ? (
        <p className="text-center text-sm text-ink/60">
          You’re watching this one — no shouting the answers.
        </p>
      ) : answered ? (
        <p className="text-center text-sm text-mint-deep">
          Locked in. Waiting for your opponent…
        </p>
      ) : (
        <p className="text-center text-sm text-ink/50">Pick fast — ties are broken on time.</p>
      )}

      {error && (
        <p className="rounded-2xl bg-coral/10 px-4 py-3 text-center text-sm text-coral-deep">
          {error}
        </p>
      )}
    </Screen>
  )
}
