import { isStaleSessionError, recoverStaleSession, supabase } from './supabase'
import type { JoinResult, LeaderboardRow, LiveQuestion, MatchResults, MatchTheme } from './types'

/**
 * Every game action is a SECURITY DEFINER RPC -- the client has no write access
 * to any table. Postgres raises plain-English messages, so surface them as-is.
 *
 * One case is intercepted rather than surfaced: a foreign-key violation on
 * auth.users means this tab is holding a JWT for an account that has since been
 * deleted server-side. The raw error ("violates foreign key constraint
 * players_user_id_fkey") is meaningless to a player, and the situation is
 * entirely recoverable -- sign in fresh and try once more. Only retried once,
 * so a genuine constraint bug still surfaces instead of looping.
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (!error) return data as T

  if (isStaleSessionError(error.message)) {
    await recoverStaleSession()
    const retry = await supabase.rpc(fn, args)
    if (!retry.error) return retry.data as T
    throw new Error(
      isStaleSessionError(retry.error.message)
        ? 'Your session expired. Reload the page and try again.'
        : retry.error.message.replace(/^.*?:\s*/, ''),
    )
  }

  throw new Error(error.message.replace(/^.*?:\s*/, ''))
}

export const createRoom = (nickname: string) =>
  rpc<JoinResult>('create_room', { p_nickname: nickname })

export const joinRoom = (code: string, nickname: string) =>
  rpc<JoinResult>('join_room', { p_code: code, p_nickname: nickname })

/** Heartbeat: marks the room as still open so the cleanup job leaves it alone. */
export const touchRoom = (roomId: string) =>
  rpc<void>('touch_room', { p_room_id: roomId })

export const leaveRoom = (roomId: string) =>
  rpc<void>('leave_room', { p_room_id: roomId })

export const removePlayer = (roomId: string, playerId: string) =>
  rpc<{ removed_player_id: string; nickname: string }>('remove_player', {
    p_room_id: roomId,
    p_player_id: playerId,
  })

export const setRoomOptions = (roomId: string, mysteryThemes: boolean) =>
  rpc<{ mystery_themes: boolean }>('set_room_options', {
    p_room_id: roomId,
    p_mystery_themes: mysteryThemes,
  })

export const getMatchTheme = (matchId: string) =>
  rpc<MatchTheme>('get_match_theme', { p_match_id: matchId })

/** Sandbox only: build the next duel with you either duelling or betting. */
export const devStartRound = (roomId: string, mode: 'play' | 'bet') =>
  rpc<{ match_id: string; mode: string; match_index: number }>('dev_start_round', {
    p_room_id: roomId,
    p_mode: mode,
  })

export const startGame = (roomId: string) =>
  rpc<{ match_count: number; current_match_id: string }>('start_game', { p_room_id: roomId })

export const placeBet = (matchId: string, backedPlayerId: string, amount: number) =>
  rpc<{ amount: number }>('place_bet', {
    p_match_id: matchId,
    p_backed_player_id: backedPlayerId,
    p_amount: amount,
  })

export const lockBetting = (matchId: string) =>
  rpc<{ status: string }>('lock_betting', { p_match_id: matchId })

export const getCurrentQuestion = (matchId: string) =>
  rpc<LiveQuestion>('get_current_question', { p_match_id: matchId })

export const submitAnswer = (matchQuestionId: string, selectedIndex: number) =>
  rpc<{ accepted: boolean }>('submit_answer', {
    p_match_question_id: matchQuestionId,
    p_selected_index: selectedIndex,
  })

export const advanceMatch = (matchId: string) =>
  rpc<{ status: string; position?: number }>('advance_match', { p_match_id: matchId })

export const nextRound = (roomId: string) =>
  rpc<{ status: string }>('next_round', { p_room_id: roomId })

export const getMatchResults = (matchId: string) =>
  rpc<MatchResults>('get_match_results', { p_match_id: matchId })

export const getLeaderboard = (roomId: string) =>
  rpc<LeaderboardRow[]>('get_leaderboard', { p_room_id: roomId })
