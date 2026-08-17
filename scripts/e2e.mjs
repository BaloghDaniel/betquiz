// End-to-end test through the real client SDK, against the real project.
// Verifies anonymous auth, the anti-cheat guarantees, and a full game.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// Read .env.local the same way Vite does, so this runs with no extra config.
for (const line of readFileSync(new global.URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) process.env[m[1]] ??= m[2]
}

const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY

let failures = 0
const ok = (label) => console.log(`  PASS  ${label}`)
const fail = (label, detail) => {
  failures++
  console.log(`  FAIL  ${label}\n        ${detail}`)
}
function check(label, cond, detail = '') {
  if (cond) ok(label)
  else fail(label, detail)
}

const mkClient = () =>
  createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

async function signIn(c) {
  const { data, error } = await c.auth.signInAnonymously()
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`)
  return data.user.id
}

const rpc = async (c, fn, args) => {
  const { data, error } = await c.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data
}

const userIds = []

try {
  console.log('\n1. Anonymous auth')
  const clients = []
  for (let i = 0; i < 5; i++) {
    const c = mkClient()
    userIds.push(await signIn(c))
    clients.push(c)
  }
  ok('five devices signed in anonymously')

  console.log('\n2. Create + join')
  const created = await rpc(clients[0], 'create_room', { p_nickname: 'Dani' })
  const roomId = created.room_id
  const code = created.code
  check('room created with a 6-char code', /^[A-Z2-9]{6}$/.test(code), code)
  for (let i = 1; i < 5; i++) {
    await rpc(clients[i], 'join_room', { p_code: code, p_nickname: `P${i + 1}` })
  }
  const { data: roster } = await clients[0].from('players').select('*').eq('room_id', roomId)
  check('all five players are in the room', roster?.length === 5, `got ${roster?.length}`)

  console.log('\n3. Anti-cheat: the tables a player must never read')
  const q = await clients[1].from('questions').select('*').limit(1)
  check(
    'questions table is unreadable from the client',
    (q.data?.length ?? 0) === 0,
    `returned ${q.data?.length} rows / error=${q.error?.message}`,
  )
  const mq = await clients[1].from('match_questions').select('*').limit(1)
  check(
    'match_questions is unreadable',
    (mq.data?.length ?? 0) === 0,
    `returned ${mq.data?.length} rows`,
  )
  const ans = await clients[1].from('answers').select('*').limit(1)
  check('answers is unreadable', (ans.data?.length ?? 0) === 0, `returned ${ans.data?.length} rows`)

  console.log('\n4. Anti-cheat: a player cannot forge the ledger')
  const forge = await clients[1]
    .from('drinks')
    .insert({ room_id: roomId, match_id: roomId, player_id: roster[0].id, mouthfuls: 99, reason: 'lost_bet' })
  check('cannot insert into drinks', forge.error !== null, 'insert was allowed!')
  const tamper = await clients[1].from('matches').update({ p1_score: 10 }).eq('room_id', roomId)
  const { data: untouched } = await clients[0].from('matches').select('p1_score').eq('room_id', roomId)
  check(
    'cannot update match scores',
    tamper.error !== null || (untouched ?? []).every((m) => m.p1_score === 0),
    'score update went through!',
  )

  console.log('\n5. An outsider cannot see the room')
  const outsider = mkClient()
  userIds.push(await signIn(outsider))
  const peek = await outsider.from('rooms').select('*').eq('id', roomId)
  check('outsider sees no rooms', (peek.data?.length ?? 0) === 0, `saw ${peek.data?.length}`)
  let blocked = false
  try {
    await rpc(outsider, 'get_leaderboard', { p_room_id: roomId })
  } catch {
    blocked = true
  }
  check('outsider is rejected by get_leaderboard', blocked)

  console.log('\n6. Start the game')
  const started = await rpc(clients[0], 'start_game', { p_room_id: roomId })
  check('5 players produced 2 duels', started.match_count === 2, `got ${started.match_count}`)
  const { data: matches } = await clients[0].from('matches').select('*').eq('room_id', roomId).order('match_index')
  const m1 = matches[0]

  console.log('\n7. Betting')
  const duellists = [m1.player1_id, m1.player2_id]
  const specIdx = roster.findIndex((p) => !duellists.includes(p.id))
  // map a player row back to the client that signed in as them
  const clientFor = (playerId) => {
    const uid = roster.find((r) => r.id === playerId).user_id
    return clients[userIds.indexOf(uid)]
  }
  const spectator = roster[specIdx]
  await rpc(clientFor(spectator.id), 'place_bet', {
    p_match_id: m1.id,
    p_backed_player_id: m1.player2_id,
    p_amount: 4,
  })
  ok('spectator backed player 2 with 4')

  let betBlocked = false
  try {
    await rpc(clientFor(m1.player1_id), 'place_bet', {
      p_match_id: m1.id,
      p_backed_player_id: m1.player1_id,
      p_amount: 3,
    })
  } catch {
    betBlocked = true
  }
  check('a duellist cannot bet on their own duel', betBlocked)

  const overMax = await rpc(clientFor(spectator.id), 'place_bet', {
    p_match_id: m1.id,
    p_backed_player_id: m1.player2_id,
    p_amount: 999,
  })
  check('an oversized stake is clamped to max_bet', overMax.amount === 5, `got ${overMax.amount}`)

  let notOwner = false
  try {
    await rpc(clients[1], 'lock_betting', { p_match_id: m1.id })
  } catch {
    notOwner = true
  }
  check('only the host can start the duel', notOwner)

  console.log('\n8. Play the duel')
  await rpc(clients[0], 'lock_betting', { p_match_id: m1.id })
  const c1 = clientFor(m1.player1_id)
  const c2 = clientFor(m1.player2_id)

  for (let i = 0; i < 10; i++) {
    const view = await rpc(c1, 'get_current_question', { p_match_id: m1.id })
    if (i === 0) {
      const keys = Object.keys(view)
      check(
        'the live question payload carries no answer key',
        !keys.some((k) => /correct|answer_index|solution/.test(k)),
        keys.join(','),
      )
      check('it does carry the prompt and 4 options', !!view.prompt && view.options.length === 4)
      check('duellist is flagged as such', view.is_duellist === true)
      const specView = await rpc(clientFor(spectator.id), 'get_current_question', { p_match_id: m1.id })
      check('spectator sees the question but is not a duellist', specView.is_duellist === false && !!specView.prompt)
    }
    // Answer without knowing the answer -- always pick A. The point is the flow,
    // not the score; whoever wins, the ledger must be consistent.
    await rpc(c1, 'submit_answer', { p_match_question_id: view.match_question_id, p_selected_index: 0 })
    await rpc(c2, 'submit_answer', { p_match_question_id: view.match_question_id, p_selected_index: 1 })
    await rpc(c1, 'advance_match', { p_match_id: m1.id })
  }

  const res = await rpc(c1, 'get_match_results', { p_match_id: m1.id })
  check('duel finished with 10 questions reviewable', res.questions.length === 10)
  check('scores add up to at most 10 each', res.p1_score <= 10 && res.p2_score <= 10)
  check('the review now reveals correct answers', typeof res.questions[0].correct_index === 'number')

  const totalDrinks = res.drinks.reduce((s, d) => s + d.mouthfuls, 0)
  if (res.is_draw) {
    check('a draw means nobody drinks', totalDrinks === 0)
  } else {
    const loserPenalty = res.drinks.find((d) => d.reason === 'quiz_loss')
    check('the losing duellist owes the 3-mouthful penalty', loserPenalty?.mouthfuls === 3, JSON.stringify(res.drinks))
    const backedWinner = res.bets[0].won
    const betDrink = res.drinks.find((d) => d.reason === 'lost_bet')
    check(
      'the bettor drinks their stake only if they backed the loser',
      backedWinner ? !betDrink : betDrink?.mouthfuls === 5,
      `won=${backedWinner} drink=${JSON.stringify(betDrink)}`,
    )
  }

  console.log('\n9. Results screen holds until the host advances')
  const { data: roomNow } = await clients[0].from('rooms').select('*').eq('id', roomId).single()
  check('room still points at the finished duel', roomNow.current_match_id === m1.id)
  const { data: m2row } = await clients[0].from('matches').select('*').eq('id', matches[1].id).single()
  check('the next duel has not opened yet', m2row.status === 'pending', m2row.status)

  await rpc(clients[0], 'next_round', { p_room_id: roomId })
  const { data: m2after } = await clients[0].from('matches').select('*').eq('id', matches[1].id).single()
  check('host advanced to duel 2 betting', m2after.status === 'betting', m2after.status)

  console.log('\n10. Finish the game')
  await rpc(clients[0], 'lock_betting', { p_match_id: matches[1].id })
  const d1 = clientFor(matches[1].player1_id)
  const d2 = clientFor(matches[1].player2_id)
  for (let i = 0; i < 10; i++) {
    const view = await rpc(d1, 'get_current_question', { p_match_id: matches[1].id })
    await rpc(d1, 'submit_answer', { p_match_question_id: view.match_question_id, p_selected_index: 0 })
    await rpc(d2, 'submit_answer', { p_match_question_id: view.match_question_id, p_selected_index: 2 })
    await rpc(d1, 'advance_match', { p_match_id: matches[1].id })
  }
  const done = await rpc(clients[0], 'next_round', { p_room_id: roomId })
  check('game closed out', done.status === 'finished', done.status)

  const board = await rpc(clients[0], 'get_leaderboard', { p_room_id: roomId })
  check('leaderboard lists all 5 players', board.length === 5, `got ${board.length}`)
  check(
    'leaderboard is sorted by fewest mouthfuls',
    board.every((r, i) => i === 0 || board[i - 1].mouthfuls <= r.mouthfuls),
  )
  console.log('   ', board.map((r) => `${r.nickname}:${r.mouthfuls}`).join('  '))

  console.log('\n11. Nickname collision')
  const dupe = mkClient()
  userIds.push(await signIn(dupe))
  let dupeBlocked = false
  try {
    await rpc(dupe, 'join_room', { p_code: code, p_nickname: 'Dani' })
  } catch (e) {
    dupeBlocked = /already/i.test(e.message)
  }
  check('a finished game rejects new joiners', dupeBlocked)

  console.log(`\nCLEANUP_IDS=${userIds.join(',')}`)
  console.log(`ROOM_ID=${roomId}`)
} catch (e) {
  failures++
  console.error('\nTHREW:', e.message)
  console.log(`\nCLEANUP_IDS=${userIds.join(',')}`)
}

console.log(failures === 0 ? '\n=== ALL CHECKS PASSED ===' : `\n=== ${failures} FAILURE(S) ===`)
process.exit(failures === 0 ? 0 : 1)
