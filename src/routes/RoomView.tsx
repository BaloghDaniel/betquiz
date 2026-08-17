import { useNavigate, useParams } from 'react-router-dom'
import { useRoom } from '../hooks/useRoom'
import Screen from '../components/Screen'
import Lobby from '../components/Lobby'
import Betting from '../components/Betting'
import Quiz from '../components/Quiz'
import RoundResult from '../components/RoundResult'
import Leaderboard from '../components/Leaderboard'

/**
 * The room drives itself: the server owns the state machine and every screen
 * here is just a rendering of room.status plus the current match's status.
 */
export default function RoomView({ userId }: { userId: string }) {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const state = useRoom(roomId, userId)
  const { room, me, currentMatch, loading, error } = state

  if (loading) {
    return (
      <Screen>
        <p className="text-center text-white/50">Loading room…</p>
      </Screen>
    )
  }

  if (error || !room || !me) {
    return (
      <Screen>
        <div className="card text-center">
          <h1 className="text-xl font-bold text-amber">Can’t open this room</h1>
          <p className="mt-2 text-sm text-white/70">
            {error ?? 'You are not a player in this room.'}
          </p>
        </div>
        <button className="btn-ghost" onClick={() => navigate('/')}>
          Back to start
        </button>
      </Screen>
    )
  }

  if (room.status === 'lobby') return <Lobby state={state} />
  if (room.status === 'finished') return <Leaderboard state={state} />

  if (!currentMatch) {
    return (
      <Screen>
        <p className="text-center text-white/50">Waiting for the next round…</p>
      </Screen>
    )
  }

  switch (currentMatch.status) {
    case 'betting':
      return <Betting state={state} match={currentMatch} />
    case 'active':
      return <Quiz state={state} match={currentMatch} />
    case 'finished':
      return <RoundResult state={state} match={currentMatch} />
    default:
      return (
        <Screen>
          <p className="text-center text-white/50">Getting the next duel ready…</p>
        </Screen>
      )
  }
}
