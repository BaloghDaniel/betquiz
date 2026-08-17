export type RoomStatus = 'lobby' | 'in_progress' | 'finished'
export type MatchStatus = 'pending' | 'betting' | 'active' | 'finished'

export interface Room {
  id: string
  code: string
  owner_id: string
  status: RoomStatus
  current_match_id: string | null
  questions_per_match: number
  penalty_mouthfuls: number
  max_bet: number
  question_seconds: number
}

export interface Player {
  id: string
  room_id: string
  user_id: string
  nickname: string
  is_owner: boolean
  joined_at: string
}

export interface Match {
  id: string
  room_id: string
  match_index: number
  player1_id: string
  player2_id: string
  status: MatchStatus
  winner_id: string | null
  is_draw: boolean
  p1_score: number
  p2_score: number
  current_position: number
}

export interface Bet {
  id: string
  match_id: string
  bettor_id: string
  backed_player_id: string
  amount: number
}

export interface Drink {
  id: string
  room_id: string
  match_id: string
  player_id: string
  mouthfuls: number
  reason: 'lost_bet' | 'quiz_loss'
}

/** Payload of get_current_question. Never carries the correct answer. */
export interface LiveQuestion {
  match_id: string
  match_question_id: string
  status: MatchStatus
  position: number
  total: number
  prompt: string
  options: string[]
  category: string
  asked_at: string
  deadline: string
  server_now: string
  is_duellist: boolean
  my_answer: { selected_index: number } | null
  p1_answered: boolean
  p2_answered: boolean
  p1_score: number
  p2_score: number
  previous: {
    position: number
    prompt: string
    options: string[]
    correct_index: number
    p1_correct: boolean
    p2_correct: boolean
  } | null
}

export interface MatchResults {
  match_id: string
  p1: { id: string; nickname: string }
  p2: { id: string; nickname: string }
  p1_score: number
  p2_score: number
  p1_ms: number
  p2_ms: number
  winner_id: string | null
  is_draw: boolean
  questions: {
    position: number
    prompt: string
    options: string[]
    correct_index: number
    p1_selected: number | null
    p2_selected: number | null
  }[]
  bets: { bettor: string; backed: string; amount: number; won: boolean }[]
  drinks: { player: string; mouthfuls: number; reason: 'lost_bet' | 'quiz_loss' }[]
}

export interface LeaderboardRow {
  id: string
  nickname: string
  mouthfuls: number
  wins: number
  losses: number
  bets_won: number
  bets_lost: number
}

export interface JoinResult {
  room_id: string
  code: string
  player_id: string
  is_owner: boolean
}
