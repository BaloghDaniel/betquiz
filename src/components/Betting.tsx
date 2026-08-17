import { useState } from 'react'
import type { RoomState } from '../hooks/useRoom'
import type { Match } from '../lib/types'
import { lockBetting, placeBet } from '../lib/api'
import Screen from './Screen'

export default function Betting({ state, match }: { state: RoomState; match: Match }) {
  const { room, players, bets, matches, me } = state

  const matchBets = bets.filter((b) => b.match_id === match.id)
  const myBet = me ? matchBets.find((b) => b.bettor_id === me.id) : undefined

  // Seeded from any existing bet so a refresh mid-betting restores the choice.
  // RoomView keys this component by match id, so these reset for every duel.
  const [selected, setSelected] = useState<string | null>(myBet?.backed_player_id ?? null)
  const [amount, setAmount] = useState(myBet?.amount ?? 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!room || !me) return null

  const name = (id: string) => players.find((p) => p.id === id)?.nickname ?? '—'
  const p1 = match.player1_id
  const p2 = match.player2_id
  const amDuellist = me.id === p1 || me.id === p2
  const unchanged =
    myBet !== undefined && myBet.backed_player_id === selected && myBet.amount === amount

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const Duellist = ({ id, tone }: { id: string; tone: 'amber' | 'violet' }) => {
    const active = selected === id
    const ring = tone === 'amber' ? 'border-amber bg-amber/15' : 'border-violet bg-violet/15'
    const backers = matchBets.filter((b) => b.backed_player_id === id)
    const pot = backers.reduce((s, b) => s + b.amount, 0)
    return (
      <button
        disabled={amDuellist}
        onClick={() => setSelected(id)}
        className={`flex-1 rounded-3xl border-2 p-4 text-center transition active:scale-[0.98] disabled:active:scale-100 ${
          active ? ring : 'border-ink-line bg-ink-soft/60'
        }`}
      >
        <div className="truncate text-lg font-bold">{name(id)}</div>
        <div className="mt-1 text-xs text-white/40">
          {backers.length === 0 ? 'no backers' : `${backers.length} backing · ${pot}`}
        </div>
      </button>
    )
  }

  return (
    <Screen
      header={
        <div className="flex items-center justify-between pt-2 text-xs uppercase tracking-widest text-white/40">
          <span>
            Duel {match.match_index + 1} of {matches.length}
          </span>
          <span>{room.code}</span>
        </div>
      }
    >
      <h1 className="text-center text-2xl font-bold">
        {amDuellist ? 'You’re up next' : 'Place your bet'}
      </h1>

      <div className="flex items-stretch gap-3">
        <Duellist id={p1} tone="amber" />
        <div className="flex items-center text-sm font-bold text-white/30">vs</div>
        <Duellist id={p2} tone="violet" />
      </div>

      {amDuellist ? (
        <p className="text-center text-white/60">
          You’re in this duel, so you can’t bet on it. {room.questions_per_match} questions,{' '}
          {room.question_seconds} seconds each. Lose and you drink {room.penalty_mouthfuls}.
        </p>
      ) : (
        <>
          <div className="card">
            <div className="flex items-baseline justify-between">
              <span className="font-semibold">Your stake</span>
              <span className="text-sm text-white/40">max {room.max_bet}</span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button
                className="h-14 w-14 shrink-0 rounded-2xl border border-ink-line bg-ink text-2xl active:scale-95"
                onClick={() => setAmount((a) => Math.max(1, a - 1))}
              >
                −
              </button>
              <div className="flex-1 text-center">
                <div className="text-4xl font-black text-amber">{amount}</div>
                <div className="text-xs text-white/40">
                  {amount === 1 ? 'mouthful' : 'mouthfuls'}
                </div>
              </div>
              <button
                className="h-14 w-14 shrink-0 rounded-2xl border border-ink-line bg-ink text-2xl active:scale-95"
                onClick={() => setAmount((a) => Math.min(room.max_bet, a + 1))}
              >
                +
              </button>
            </div>
            <p className="mt-3 text-center text-xs text-white/40">
              Back the loser and you drink {amount}. Back the winner and you drink nothing.
            </p>
          </div>

          <button
            className="btn-primary"
            disabled={!selected || busy || unchanged}
            onClick={() => void run(() => placeBet(match.id, selected!, amount))}
          >
            {busy
              ? 'Saving…'
              : !selected
                ? 'Pick a player'
                : unchanged
                  ? `Bet placed: ${amount} on ${name(selected)}`
                  : myBet
                    ? `Change to ${amount} on ${name(selected)}`
                    : `Bet ${amount} on ${name(selected)}`}
          </button>
        </>
      )}

      {matchBets.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-white/60">Bets on the table</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {matchBets.map((b) => (
              <li key={b.id} className="flex justify-between text-white/70">
                <span>
                  {name(b.bettor_id)}
                  {b.bettor_id === me.id && <span className="ml-1 text-white/30">(you)</span>}
                </span>
                <span>
                  {b.amount} on <span className="text-white">{name(b.backed_player_id)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {me.is_owner ? (
        <button
          className="btn-ghost"
          disabled={busy}
          onClick={() => void run(() => lockBetting(match.id))}
        >
          {busy ? 'Starting…' : 'Start the duel'}
        </button>
      ) : (
        <p className="text-center text-sm text-white/40">Waiting for the host to start the duel…</p>
      )}

      {error && (
        <p className="rounded-2xl bg-red-500/10 px-4 py-3 text-center text-sm text-red-300">
          {error}
        </p>
      )}
    </Screen>
  )
}
