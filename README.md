# BetQuiz

A party game PWA: two players duel over 10 trivia questions while everyone else
bets **mouthfuls** on who wins. Back the loser and you drink your stake. Lose the
duel and you drink a flat penalty.

Live at **https://baloghdaniel.github.io/betquiz**

> Picking this project up in a fresh AI session? Read
> [`AI-README.md`](AI-README.md) first — it covers the security model's
> reasoning, two real bugs found during development and why normal testing
> missed them, and deployment gotchas that aren't obvious from the code alone.

## How a game goes

1. Someone creates a room and reads the 6-character code out to the table. In
   the lobby, the host can flip on **Mystery themes**.
2. Everyone joins on their own phone — no signup, just a nickname.
3. The host starts. Players are shuffled and paired into 1v1 duels. With an odd
   headcount, the spare player sits out and bets on every round. Each duel draws
   two candidate themes from eight — Sport, Geography, Music, Celebrities,
   Film & TV, History, Science & Nature, Random Facts.
4. Duels play **one at a time**. Each duel puts **two candidate themes** in the
   running, and everyone not duelling stakes 1–5 mouthfuls on a player knowing
   it could be either — back the geography whiz and hope geography wins the
   flip. With mystery themes **on**, even the two candidates stay hidden and
   you bet completely blind.
5. When the host closes betting, the server rolls one of the two themes at
   random. Every phone plays a slot-machine flip between the candidates, then
   holds for 5 seconds on the winner with every bet on the table listed.
6. The two duellists answer the same 10 questions, all from the theme that won,
   on a timer. Most correct wins; a tie is broken by total answer time; a dead
   heat voids all bets.
7. The result screen shows exactly who owes what. The host moves things on when
   the drinking is done.
8. After the last duel, a leaderboard ranks everyone by how little they drank.

## Stack

- **Frontend** — Vite + React + TypeScript, Tailwind v4, installable PWA
  (`vite-plugin-pwa`). Routing is `HashRouter` because GitHub Pages has no SPA
  rewrite.
- **Backend** — Supabase Postgres. Live state reaches every phone over Supabase
  Realtime.
- **Hosting** — GitHub Pages, built and deployed by
  [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push to
  `master`.

## The security model

A static site ships a **public** Supabase key, so the database assumes the client
is hostile:

- Clients have **no write access to any table**. Every action goes through a
  `SECURITY DEFINER` RPC that re-checks `auth.uid()` and the caller's role.
- `questions`, `match_questions`, `answers` and `match_themes` are **not
  readable by clients at all**. Without this, a player could open devtools and
  read `correct_index` mid-duel, or read a "mystery" theme straight off the
  `matches`-adjacent table before betting closes.
- `get_current_question` returns the prompt and options and never the answer.
  Grading happens server-side inside `submit_answer`; the client only sends an
  index. Correct answers are released by `get_match_results`, and only once the
  match is finished.
- Scores, winners and the drinks ledger are computed in the database, so a
  player cannot forge a win or wipe their own tab.
- Read access to the live-state tables (`rooms`, `players`, `matches`, `bets`,
  `drinks`) is scoped by RLS to rooms you are actually in.

`npm run test:e2e` asserts all of the above against the real project.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open the printed URL in several browser profiles (or on a laptop plus a couple of
phones on the same network via `npm run dev -- --host`) to play a full game.

```bash
npm run build         # typecheck + production build
npm run test:e2e      # full game + anti-cheat assertions against Supabase
npm run test:dev-room # the solo sandbox, end to end
```

### Playing on your own

Joining with the room code **`111111`** drops you into a sandbox with two bots,
so the whole chain is playable without rounding up four friends. Before each
round you choose whether to **play** (you versus a bot, the spare bot bets on
you) or **bet** (the two bots duel while you stake mouthfuls on one). Rejoining
resets it to a clean lobby.

### Housekeeping

A scheduled job sweeps the database every 5 minutes: rooms go once they have
been idle for 10 minutes, and anonymous users go once they belong to no room.
Nothing needs clearing out by hand, including after a test run — while a game is
actually being played every phone in the room checks in every 30 seconds, which
is what keeps the room alive.

## Database

Migrations live in [`supabase/migrations/`](supabase/migrations) and are numbered
in apply order:

| file | contents |
| --- | --- |
| `0001_schema.sql` | tables |
| `0002_rpcs.sql` | all game logic |
| `0003_rls.sql` | row level security, table grants, function grants |
| `0004_realtime.sql` | Realtime publication |
| `0005_seed_questions.sql` | starter questions |
| `0006_next_round.sql` | host-paced handover between duels |
| `0007_leaderboard_scope.sql` | scope leaderboard queries to the room + indexes |
| `0008_fix_rls_helper_grants.sql` | grant `EXECUTE` on the RLS helper functions |
| `0009_themes.sql` | eight question themes, `match_themes`, mystery-themes option |
| `0010`–`0017_seed_*.sql` | question bank, ~100 per theme (807 total) |
| `0018_fix_theme_question_positions.sql` | fix scrambled `position` values from `0009` |
| `0019_remove_player.sql` | host can remove a player from the lobby |
| `0020_theme_showdown.sql` | two candidate themes per duel, rolled when betting closes |
| `0021_dev_room.sql` | the `111111` solo sandbox: bot players, `dev_start_round` |
| `0022_bot_answer_timing.sql` | bots answer after 2–5s instead of sitting on the timer |
| `0023_scheduled_cleanup.sql` | `room_activity` heartbeat table, `touch_room`, `bq_cleanup` |
| `0024_schedule_cleanup_job.sql` | `pg_cron` job running the sweep every 5 minutes |
| `0025_cleanup_protect_room_owners.sql` | stop the user sweep cascading away live rooms |
| `0026_revoke_internal_dev_helpers.sql` | make the dev-room helpers actually internal |

Adding your own questions is a plain insert — `options` is a 4-element array,
`correct_index` is 0-based, and `category` must be one of the eight themes:

```sql
insert into public.questions (prompt, options, correct_index, category, difficulty)
values ('Who is buying the next round?',
        array['Dani','Not Dani','Definitely Dani','Dani again'], 0, 'Random Facts', 'easy');
```

`start_game` gives each duel two candidate themes (`match_themes.category_a` /
`category_b`) but draws no questions. `lock_betting` rolls the winner into
`match_themes.category`, draws that theme's questions, and opens a reveal window
(`matches.reveal_until`). The roll happens after betting closes on purpose:
there is no predetermined result sitting around to leak. During the reveal
`get_current_question` withholds the prompt entirely, and `submit_answer`
rejects anything sent before `asked_at` — otherwise a duellist could answer
while the animation is still playing and gain free thinking time.

## Room settings

Defaults live on the `rooms` table and apply to every new room:
10 questions per duel, 20 seconds per question, a 5-second theme reveal, a
maximum stake of 5 mouthfuls, and a 3-mouthful penalty for losing a duel. Change
the column defaults to change the house rules. The first question's clock starts
when the reveal ends, so lengthening the reveal never costs answering time.
