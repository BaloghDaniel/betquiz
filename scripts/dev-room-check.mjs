// Exercises the 111111 sandbox end to end: both "I play" and "I bet" rounds,
// bots answering on their own, and the ledger settling correctly.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new global.URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) process.env[m[1]] ??= m[2]
}

let failures = 0
const ok = (l) => console.log(`  PASS  ${l}`)
const check = (l, c, d = '') => { if (c) ok(l); else { failures++; console.log(`  FAIL  ${l}\n        ${d}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const c = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const rpc = async (fn, args) => {
  const { data, error } = await c.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message.replace(/^.*?:\s*/, '')}`)
  return data
}

async function waitForReveal(matchId) {
  for (let i = 0; i < 40; i++) {
    const v = await rpc('get_current_question', { p_match_id: matchId })
    if (!v.revealing) return v
    await sleep(400)
  }
  throw new Error('reveal never closed')
}

/**
 * Drive a duel exactly the way src/components/Quiz.tsx does.
 *
 * The advance condition below deliberately mirrors the client's rather than
 * calling advance_match unconditionally. An earlier version of this helper did
 * call it every loop, which hid a real bug: bots only answer inside
 * advance_match, so a client that waits for "both answered or expired" never
 * triggers them and every question runs its full timer. Testing more
 * aggressively than the real client meant the deadlock never showed up here.
 */
async function playOut(matchId, iAmDuellist, botIds) {
  let lastAdvance = 0
  for (let guard = 0; guard < 300; guard++) {
    const v = await rpc('get_current_question', { p_match_id: matchId })
    if (v.status === 'finished') return
    if (v.revealing) { await sleep(300); continue }

    if (iAmDuellist && v.is_duellist && !v.my_answer) {
      await rpc('submit_answer', { p_match_question_id: v.match_question_id, p_selected_index: 0 })
      continue
    }

    const { data: m } = await c.from('matches').select('player1_id,player2_id').eq('id', matchId).single()
    const bothIn = v.p1_answered && v.p2_answered
    const expired = !!v.deadline && Date.now() > new Date(v.deadline).getTime()
    const botOwes =
      (botIds.includes(m.player1_id) && !v.p1_answered) ||
      (botIds.includes(m.player2_id) && !v.p2_answered)

    if ((bothIn || expired || botOwes) && Date.now() - lastAdvance > 800) {
      lastAdvance = Date.now()
      const r = await rpc('advance_match', { p_match_id: matchId })
      if (r.status === 'finished') return
    }
    await sleep(300)
  }
  throw new Error('duel never finished')
}

const ids = []
try {
  const { data: auth, error: aerr } = await c.auth.signInAnonymously()
  if (aerr) throw aerr
  ids.push(auth.user.id)

  console.log('\n1. Joining the sandbox with code 111111')
  const join = await rpc('join_room', { p_code: '111111', p_nickname: 'Dev' })
  check('joined without anyone else present', !!join.room_id && join.code === '111111')
  check('you are the owner', join.is_owner === true)
  const roomId = join.room_id

  const { data: room } = await c.from('rooms').select('*').eq('id', roomId).single()
  check('room is flagged as the sandbox', room.is_dev === true)
  check('room starts in the lobby', room.status === 'lobby', room.status)

  const { data: roster } = await c.from('players').select('*').eq('room_id', roomId)
  check('three players: you and two bots', roster.length === 3, `got ${roster.length}`)
  check('exactly two are bots', roster.filter((p) => p.is_bot).length === 2)
  check('bots have no auth identity', roster.filter((p) => p.is_bot).every((p) => p.user_id === null))
  console.log(`        roster: ${roster.map((p) => p.nickname + (p.is_bot ? ' (bot)' : '')).join(', ')}`)

  console.log('\n2. Round where I play (you vs a bot)')
  const r1 = await rpc('dev_start_round', { p_room_id: roomId, p_mode: 'play' })
  const { data: m1 } = await c.from('matches').select('*').eq('id', r1.match_id).single()
  const me = roster.find((p) => !p.is_bot)
  check('you are one of the duellists', [m1.player1_id, m1.player2_id].includes(me.id))
  const { data: bets1 } = await c.from('bets').select('*').eq('match_id', m1.id)
  check('the spare bot placed a bet', bets1.length === 1, `got ${bets1.length}`)

  const botIds = roster.filter((p) => p.is_bot).map((p) => p.id)
  await rpc('lock_betting', { p_match_id: m1.id })
  await waitForReveal(m1.id)
  await playOut(m1.id, true, botIds)

  const res1 = await rpc('get_match_results', { p_match_id: m1.id })
  check('the duel finished with a result', !!res1.winner_id || res1.is_draw)
  check('all 10 questions were answered', res1.questions.length === 10)
  const botAnswered = res1.questions.every((q) => q.p1_selected !== null && q.p2_selected !== null)
  check('the bot answered every question on its own', botAnswered,
        'some answers were null — bots did not play')
  console.log(`        score ${res1.p1_score}–${res1.p2_score}, drinks: ${JSON.stringify(res1.drinks)}`)

  console.log('\n3. Round where I bet (bot vs bot)')
  const r2 = await rpc('dev_start_round', { p_room_id: roomId, p_mode: 'bet' })
  const { data: m2 } = await c.from('matches').select('*').eq('id', r2.match_id).single()
  check('both duellists are bots', roster.filter((p) => p.is_bot)
        .filter((p) => [m2.player1_id, m2.player2_id].includes(p.id)).length === 2)
  check('you are not duelling', ![m2.player1_id, m2.player2_id].includes(me.id))

  await rpc('place_bet', { p_match_id: m2.id, p_backed_player_id: m2.player1_id, p_amount: 3 })
  ok('you placed a bet on a bot')

  const t0 = Date.now()
  await rpc('lock_betting', { p_match_id: m2.id })
  await waitForReveal(m2.id)
  await playOut(m2.id, false, botIds)
  const elapsed = (Date.now() - t0) / 1000

  const res2 = await rpc('get_match_results', { p_match_id: m2.id })
  check('the bot-vs-bot duel resolved without you', !!res2.winner_id || res2.is_draw)
  check('both bots answered all 10', res2.questions.every((q) => q.p1_selected !== null && q.p2_selected !== null))
  const myBet = res2.bets.find((b) => b.bettor === 'Dev')
  check('your bet was settled', !!myBet && typeof myBet.won === 'boolean', JSON.stringify(res2.bets))
  console.log(`        score ${res2.p1_score}–${res2.p2_score}, your bet ${myBet?.won ? 'won' : 'lost'}`)

  // The regression that prompted this: bots only answer inside advance_match,
  // so a client that does not keep calling it leaves every question to time
  // out. Ten questions at a 20s timer would be 200s+; answering in 2-5s puts a
  // full bot-vs-bot duel comfortably under a minute.
  check(`bots answered promptly, not on the timer (duel took ${elapsed.toFixed(1)}s)`,
        elapsed < 90, `took ${elapsed.toFixed(1)}s — bots are waiting out the clock`)

  console.log('\n4. Rounds accumulate, then the game closes out')
  const { data: allMatches } = await c.from('matches').select('*').eq('room_id', roomId)
  check('two rounds were recorded', allMatches.length === 2, `got ${allMatches.length}`)
  const done = await rpc('next_round', { p_room_id: roomId })
  check('game finished', done.status === 'finished', done.status)
  const board = await rpc('get_leaderboard', { p_room_id: roomId })
  check('leaderboard lists you and both bots', board.length === 3, `got ${board.length}`)
  console.log(`        ${board.map((r) => `${r.nickname}:${r.mouthfuls}`).join('  ')}`)

  console.log('\n5. Rejoining resets the sandbox')
  const rejoin = await rpc('join_room', { p_code: '111111', p_nickname: 'Dev' })
  const { data: room2 } = await c.from('rooms').select('*').eq('id', rejoin.room_id).single()
  check('back to a clean lobby', room2.status === 'lobby', room2.status)
  const { data: m3 } = await c.from('matches').select('*').eq('room_id', rejoin.room_id)
  check('previous rounds were cleared', m3.length === 0, `got ${m3.length}`)

  console.log('\n6. The sandbox cannot be used to touch a real room')
  const real = await rpc('create_room', { p_nickname: 'Dev' })
  let blocked = false
  try { await rpc('dev_start_round', { p_room_id: real.room_id, p_mode: 'play' }) }
  catch (e) { blocked = /not the sandbox/i.test(e.message) }
  check('dev_start_round refuses a normal room', blocked)

  console.log(`\nCLEANUP=${ids.join(',')}`)
} catch (e) {
  failures++
  console.error('THREW:', e.message)
  console.log(`\nCLEANUP=${ids.join(',')}`)
}
console.log(failures === 0 ? '\n=== ALL PASSED ===' : `\n=== ${failures} FAILURE(S) ===`)
process.exit(failures === 0 ? 0 : 1)
