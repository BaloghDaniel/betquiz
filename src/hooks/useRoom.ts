import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Bet, Drink, Match, Player, Room } from '../lib/types'

export interface RoomState {
  room: Room | null
  players: Player[]
  matches: Match[]
  bets: Bet[]
  drinks: Drink[]
  me: Player | null
  currentMatch: Match | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * One Realtime subscription per room, feeding every screen.
 *
 * Any change to the room refetches the whole (tiny) room state rather than
 * merging deltas by hand -- a party game's correctness matters more than the
 * handful of bytes saved, and it makes reconnects trivially consistent.
 */
export function useRoom(roomId: string | undefined, userId: string | null): RoomState {
  const [room, setRoom] = useState<Room | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [matches, setMatches] = useState<Match[]>([])
  const [bets, setBets] = useState<Bet[]>([])
  const [drinks, setDrinks] = useState<Drink[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchAll = useCallback(async () => {
    if (!roomId) return
    const [r, p, m, b, d] = await Promise.all([
      supabase.from('rooms').select('*').eq('id', roomId).maybeSingle(),
      supabase.from('players').select('*').eq('room_id', roomId).order('joined_at'),
      supabase.from('matches').select('*').eq('room_id', roomId).order('match_index'),
      supabase.from('bets').select('*'),
      supabase.from('drinks').select('*').eq('room_id', roomId),
    ])

    if (r.error) {
      setError(r.error.message)
    } else if (!r.data) {
      // RLS returns nothing both when the room is gone and when you are simply
      // no longer in it (the host removed you, or you left). The client cannot
      // tell those apart, so say something true of both rather than guessing.
      setError('This room is no longer available to you. It may have ended, or the host removed you.')
    } else {
      setError(null)
      setRoom(r.data as Room)
    }

    if (p.data) setPlayers(p.data as Player[])
    if (m.data) setMatches(m.data as Match[])
    if (d.data) setDrinks(d.data as Drink[])
    if (b.data) {
      // `bets` has no room_id; RLS already limits the rows to this player's
      // rooms, so narrow to the matches we actually loaded.
      const ids = new Set((m.data ?? []).map((x) => (x as Match).id))
      setBets((b.data as Bet[]).filter((x) => ids.has(x.match_id)))
    }
    setLoading(false)
  }, [roomId])

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void fetchAll(), 120)
  }, [fetchAll])

  useEffect(() => {
    if (!roomId) return
    void fetchAll()

    const channel = supabase.channel(`room:${roomId}`)
    for (const table of ['rooms', 'players', 'matches', 'bets', 'drinks']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, schedule)
    }
    channel.subscribe()

    // A locked phone silently drops the websocket; resync whenever the player
    // looks at the screen again.
    const onWake = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)

    // Safety net for state changes Realtime structurally cannot deliver. The
    // clearest case: when the host removes you, the players DELETE event is
    // RLS-filtered against your membership -- which no longer exists -- so you
    // are never told. Without this you would sit in a dead lobby indefinitely.
    // It also covers any events missed while the websocket was reconnecting.
    const safetyNet = setInterval(() => {
      if (document.visibilityState === 'visible') schedule()
    }, 10_000)

    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      clearInterval(safetyNet)
      if (timer.current) clearTimeout(timer.current)
      void supabase.removeChannel(channel)
    }
  }, [roomId, fetchAll, schedule])

  const me = players.find((p) => p.user_id === userId) ?? null
  const currentMatch = matches.find((m) => m.id === room?.current_match_id) ?? null

  return { room, players, matches, bets, drinks, me, currentMatch, loading, error, refresh: schedule }
}
