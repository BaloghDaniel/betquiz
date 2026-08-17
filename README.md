# BetQuiz

A party game PWA: two players duel over 10 trivia questions while everyone else
bets **mouthfuls** on who wins. Back the loser and you drink your stake. Lose the
duel and you drink a flat penalty.

Live at **https://baloghdaniel.github.io/betquiz**

## How a game goes

1. Someone creates a room and reads the 6-character code out to the table.
2. Everyone joins on their own phone — no signup, just a nickname.
3. The host starts. Players are shuffled and paired into 1v1 duels. With an odd
   headcount, the spare player sits out and bets on every round.
4. Duels play **one at a time**. Before each one, everyone not in it stakes
   1–5 mouthfuls on a player.
5. The two duellists answer the same 10 questions on a timer. Most correct wins;
   a tie is broken by total answer time; a dead heat voids all bets.
6. The result screen shows exactly who owes what. The host moves things on when
   the drinking is done.
7. After the last duel, a leaderboard ranks everyone by how little they drank.

## Stack

- **Frontend** — Vite + React + TypeScript, Tailwind v4, installable PWA
  (`vite-plugin-pwa`). Routing is `HashRouter` because GitHub Pages has no SPA
  rewrite.
- **Backend** — Supabase Postgres. Live state reaches every phone over Supabase
  Realtime.
- **Hosting** — GitHub Pages, built and deployed by
  [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push to
  `main`.

## The security model

A static site ships a **public** Supabase key, so the database assumes the client
is hostile:

- Clients have **no write access to any table**. Every action goes through a
  `SECURITY DEFINER` RPC that re-checks `auth.uid()` and the caller's role.
- `questions`, `match_questions` and `answers` are **not readable by clients at
  all**. Without this, a player could open devtools and read `correct_index`
  mid-duel.
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
npm run build      # typecheck + production build
npm run test:e2e   # full game + anti-cheat assertions against Supabase
```

`test:e2e` runs against the live project and leaves a finished room and a handful
of anonymous users behind. That is harmless, but if you run it often you may want
to clear them out periodically.

## Database

Migrations live in [`supabase/migrations/`](supabase/migrations) and are numbered
in apply order:

| file | contents |
| --- | --- |
| `0001_schema.sql` | tables |
| `0002_rpcs.sql` | all game logic |
| `0003_rls.sql` | row level security, table grants, function grants |
| `0004_realtime.sql` | Realtime publication |
| `0005_seed_questions.sql` | 160 starter questions |
| `0006_next_round.sql` | host-paced handover between duels |

Adding your own questions is a plain insert — `options` is a 4-element array and
`correct_index` is 0-based:

```sql
insert into public.questions (prompt, options, correct_index, category, difficulty)
values ('Who is buying the next round?',
        array['Dani','Not Dani','Definitely Dani','Dani again'], 0, 'general', 'easy');
```

## Room settings

Defaults live on the `rooms` table and apply to every new room:
10 questions per duel, 20 seconds per question, a maximum stake of 5 mouthfuls,
and a 3-mouthful penalty for losing a duel. Change the column defaults to change
the house rules.
