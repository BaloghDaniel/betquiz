import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RoomState } from '../hooks/useRoom'
import type { LeaderboardRow } from '../lib/types'
import { getLeaderboard } from '../lib/api'
import Screen from './Screen'

export default function Leaderboard({ state }: { state: RoomState }) {
  const { room, me } = state
  const navigate = useNavigate()
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!room) return
    getLeaderboard(room.id)
      .then(setRows)
      .catch((e: Error) => setError(e.message))
  }, [room])

  if (!room || !me) return null
  if (!rows) {
    return (
      <Screen>
        <p className="text-center text-white/50">{error ?? 'Adding it all up…'}</p>
      </Screen>
    )
  }

  // get_leaderboard already sorts by fewest mouthfuls, then most wins.
  const soberest = rows[0]
  const drunkest = [...rows].sort((a, b) => b.mouthfuls - a.mouthfuls)[0]

  return (
    <Screen
      header={
        <div className="pt-2 text-center text-xs uppercase tracking-widest text-white/40">
          Game over · {room.code}
        </div>
      }
    >
      <div className="text-center">
        <p className="text-sm uppercase tracking-widest text-white/40">Last one standing</p>
        <h1 className="mt-1 text-4xl font-black text-amber">{soberest.nickname}</h1>
        <p className="mt-2 text-white/50">
          {soberest.mouthfuls} {soberest.mouthfuls === 1 ? 'mouthful' : 'mouthfuls'} all night
        </p>
      </div>

      <div className="card">
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li
              key={r.id}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 ${
                r.id === me.id ? 'bg-amber/10' : 'bg-ink/60'
              }`}
            >
              <span className="w-5 text-sm text-white/30">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {r.nickname}
                  {r.id === me.id && <span className="ml-2 text-xs text-white/40">you</span>}
                </div>
                <div className="text-xs text-white/40">
                  {r.wins}W {r.losses}L in duels · bets {r.bets_won}–{r.bets_lost}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xl font-black tabular-nums">{r.mouthfuls}</div>
                <div className="text-[10px] uppercase tracking-wider text-white/30">drunk</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {drunkest.mouthfuls > 0 && drunkest.id !== soberest.id && (
        <p className="text-center text-sm text-white/50">
          Spare a thought for <span className="text-white">{drunkest.nickname}</span>, who put away{' '}
          {drunkest.mouthfuls}.
        </p>
      )}

      <button className="btn-primary" onClick={() => navigate('/')}>
        New game
      </button>
    </Screen>
  )
}
