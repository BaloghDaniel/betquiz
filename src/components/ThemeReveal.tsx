import type { Bet, Match, Player } from '../lib/types'

/**
 * The moment between betting closing and the questions starting.
 *
 * Runs a slot-machine flip between the two candidate themes, decelerating into
 * the one the server actually rolled, then holds on the result with every bet
 * on the table listed underneath.
 *
 * Timing is driven entirely by the server's reveal_until, not a local timer, so
 * every phone in the room lands on the answer at the same moment.
 */
export default function ThemeReveal({
  candidates,
  category,
  msLeft,
  totalMs,
  bets,
  players,
  match,
  isDuellist,
}: {
  candidates: [string, string] | null
  category: string | null
  msLeft: number
  totalMs: number
  bets: Bet[]
  players: Player[]
  match: Match
  isDuellist: boolean
}) {
  const name = (id: string) => players.find((p) => p.id === id)?.nickname ?? '—'

  // The flip occupies the first 55% of the window; the rest holds the result.
  const spinMs = Math.max(1, totalMs * 0.55)
  const elapsed = Math.max(0, totalMs - msLeft)
  const t = Math.min(1, elapsed / spinMs)
  const settled = t >= 1 || !candidates

  // Ease-out so the flip starts frantic and visibly runs out of steam, rather
  // than stopping dead on a fixed interval.
  const eased = 1 - Math.pow(1 - t, 3)
  const flips = Math.floor(eased * 14)
  const shown = settled
    ? (category ?? candidates?.[0] ?? '')
    : (candidates?.[flips % 2] ?? '')

  const matchBets = bets.filter((b) => b.match_id === match.id)
  const pot = matchBets.reduce((s, b) => s + b.amount, 0)

  return (
    <div className="flex min-h-full flex-col justify-center gap-5 px-4 py-6">
      <div className="text-center text-xs uppercase tracking-widest text-ink/50">
        {settled ? 'The theme is' : 'Picking a theme…'}
      </div>

      <div
        className={`rounded-3xl border-2 p-6 text-center transition-all duration-200 ${
          settled
            ? 'scale-100 border-accent bg-accent/15'
            : 'scale-[0.97] border-blue bg-blue/30'
        }`}
      >
        <div
          className={`font-black break-words transition-all ${
            settled ? 'text-4xl text-accent-deep' : 'text-3xl text-ink/75'
          }`}
        >
          {shown || '…'}
        </div>

        {!settled && candidates && (
          <div className="mt-3 text-xs text-ink/50">
            {candidates[0]} or {candidates[1]}
          </div>
        )}
      </div>

      {settled && (
        <>
          <div className="rounded-3xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-ink/70">Bets on the table</h2>
              {pot > 0 && <span className="text-sm text-ink/50">{pot} at stake</span>}
            </div>

            {matchBets.length === 0 ? (
              <p className="mt-2 text-sm text-ink/50">
                Nobody backed anyone this round.
              </p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {matchBets.map((b) => (
                  <li key={b.id} className="flex justify-between text-ink/75">
                    <span className="truncate">{name(b.bettor_id)}</span>
                    <span className="shrink-0">
                      {b.amount} on{' '}
                      <span className="text-ink">{name(b.backed_player_id)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-center text-sm text-ink/60">
            {isDuellist ? 'Get ready — first question in a moment.' : 'Here we go.'}
          </p>
        </>
      )}

      <div className="mx-auto h-1.5 w-32 overflow-hidden rounded-full bg-line">
        <div
          className="h-full bg-accent-deep transition-[width] duration-100 ease-linear"
          style={{ width: `${Math.max(0, Math.min(1, msLeft / totalMs)) * 100}%` }}
        />
      </div>
    </div>
  )
}
