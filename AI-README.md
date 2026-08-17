# AI-README

This file is for an AI assistant picking up this project cold, in a session that
has no memory of how it was built. Read this before touching code. It explains
*why* things are the way they are, not just what they are — the "why" is what
lets you make good judgment calls instead of guessing.

If you're a human: this is also a fine place to start, but `README.md` is the
user-facing one.

## What this is

BetQuiz — a party game PWA. Players join a room by code, get randomly paired
into 1v1 trivia duels, and everyone *not* currently duelling bets "mouthfuls"
of a drink on who wins. Losing bettors drink their stake; the losing duellist
drinks a fixed penalty. See `README.md` for the full rules and `## How a game
goes`.

- **Live**: https://baloghdaniel.github.io/betquiz
- **Repo**: https://github.com/BaloghDaniel/betquiz — public, default branch
  `master` (not `main` — the user asked for this explicitly)
- **Backend**: Supabase project `BetQuiz`, ref `uomzuypfbxyxwgvjzpgt`,
  eu-west-1. There is a second, unrelated Supabase project on the same account
  (`baloghd001@gmail.com's Project`, ref `dkhooffsrmczcnybxovt`) — never touch
  it, it's not this app's.
- **Deploy**: GitHub Actions → GitHub Pages, `.github/workflows/deploy.yml`,
  triggers on push to `master`.

## The one thing to internalize before changing anything

**The database assumes every client is hostile**, because this is a static PWA
shipping a public Supabase key — anyone can read it out of the deployed JS.
There is no other line of defense. Concretely:

- Clients hold **zero direct table grants**. Every mutation is a
  `SECURITY DEFINER` RPC in `supabase/migrations/0002_rpcs.sql` /
  `0009_themes.sql` / `0006_next_round.sql` that re-checks `auth.uid()` and the
  caller's role itself. There is no RLS `INSERT`/`UPDATE`/`DELETE` policy
  anywhere in this schema, on purpose.
- `questions`, `match_questions`, `answers`, and `match_themes` are **not
  readable by clients at all** — no grant, no policy. A client that could read
  `questions` could read `correct_index` mid-duel; one that could read
  `match_themes` could see a "mystery" theme before betting closes. Both are
  reached only through RPCs that decide what to reveal and when
  (`get_current_question`, `get_match_theme`).
- Grading happens server-side inside `submit_answer`. The client sends an
  option index and gets back `{accepted: true}` — nothing else. It never
  learns whether it was right until `get_current_question` reveals the
  *previous* question once the current one has moved on, or until
  `get_match_results` reveals everything once the match is `finished`.
- Scores, winners, and the drinks ledger are computed in Postgres
  (`bq_settle_match`), not the client. A player cannot forge a win or wipe
  their own tab by calling REST endpoints directly.
- **Function grants are as important as table grants and easy to get wrong.**
  `0003_rls.sql` does `revoke execute on all functions in schema public from
  public, anon, authenticated` and then re-grants only the RPCs meant to be
  called from the app. If you add a new RPC, you must explicitly `grant
  execute ... to authenticated` or the client gets a permission error calling
  it. If you add an internal helper that only other `SECURITY DEFINER`
  functions should call, do *not* grant it — see the RLS-helper bug below for
  why that's not just theoretical.

If you're about to add a table or a column that a client will read directly
(as opposed to through an RPC), ask: **could a hostile client abuse read
access to this the moment betting opens or a duel starts?** If yes, it needs
to go through an RPC instead, the way `match_themes` did.

## Two real bugs this session found, and what they teach

Both were caught by `scripts/e2e.mjs`, **not** by testing directly in the SQL
editor / via the Supabase MCP `execute_sql` tool. That distinction matters
enough to repeat: **SQL run through the MCP tools executes as `postgres`,
which bypasses RLS and function-grant checks entirely.** A test that only
calls RPCs and reads tables via `execute_sql` can look completely green while
the real app is broken for every actual client. Always drive at least one
pass through `scripts/e2e.mjs` (real anon-signed-in `@supabase/supabase-js`
clients, same as the browser) before believing a schema change works.

1. **Missing `EXECUTE` grant on an RLS helper function.** `0003_rls.sql`'s
   blanket function revoke also caught `bq_is_member()` and
   `bq_is_member_of_match()`, which the RLS policies on `rooms`/`players`/etc.
   call inside their `USING` clause. An RLS policy expression runs with the
   *caller's* privileges to evaluate — `SECURITY DEFINER` only governs who the
   function body runs as once it's already permitted to run, it doesn't waive
   the permission check to get in. Result: every client-side table read
   silently returned zero rows. Fixed in `0008_fix_rls_helper_grants.sql`.
   Lesson: any function referenced inside an RLS policy needs `EXECUTE`
   granted to whichever role the policy applies to, full stop.

2. **`row_number() over ()` with no `ORDER BY` inside the window, followed by
   an outer `ORDER BY random() LIMIT`.** In the original `start_game` (from
   `0009_themes.sql`), each duel's questions were numbered before the final
   random sort/limit was applied, so the stored `position` values came out as
   whatever Postgres's scan order happened to produce — not `0..9`.
   `lock_betting` always starts a duel at `current_position = 0`, and no row
   ever had `position = 0`, so `get_current_question` returned nothing and no
   duel could ever be played. Fixed in
   `0018_fix_theme_question_positions.sql` using
   `row_number() over (partition by match_id order by random())`, where the
   `ORDER BY` lives *inside* the window spec — Postgres guarantees that's the
   order row numbers are assigned in, so there's no later sort stage that can
   drift out of sync with it. Lesson: never rely on `row_number() over ()`
   (empty window) interacting correctly with a later `ORDER BY`/`LIMIT` — put
   the ordering inside the window function itself, or use a CTE that sorts
   before numbering.

`scripts/e2e.mjs` has regression assertions for both: it checks that
`get_current_question`'s `position` walks `0,1,2,...,9` with no gaps every
single iteration, and separately checks that a non-owner cannot bypass
RLS-protected reads.

## Architecture map

```
src/
  lib/supabase.ts     Supabase client + ensureSignedIn() (anonymous auth)
  lib/api.ts           Every RPC call, one function each — this is the entire
                        client→server surface. If it's not here, the client
                        can't do it.
  lib/types.ts          TS types mirroring RPC JSON shapes
  hooks/useRoom.ts     Single Realtime subscription per room; refetches room
                        state wholesale on any change rather than merging
                        deltas (simplicity over bytes, deliberate for a party
                        game's scale)
  routes/               Home (create/join), RoomView (state-machine dispatch)
  components/           Lobby, Betting, Quiz, RoundResult, Leaderboard — one
                        per room/match status. RoomView switches between them
                        purely off `room.status` and `currentMatch.status`,
                        keyed by match id so each duel gets fresh local state.

supabase/migrations/    Applied in numeric order via the Supabase MCP
                        `apply_migration` tool (no local Postgres, no
                        `psql`, no service-role key in this environment —
                        migrations are the only way schema changes happen).
                        See the table in README.md for what each one does.

scripts/e2e.mjs         The test that matters most. Full game through the
                        real client SDK: anon auth, anti-cheat table-read
                        checks, betting rules, a complete themed duel,
                        mystery-themes reveal timing, leaderboard. Run before
                        trusting any schema change. `npm run test:e2e`.
                        Leaves anonymous test users + a finished room behind
                        on success — harmless, but periodically clean up with
                        `delete from auth.users where is_anonymous = true;`
                        via the Supabase MCP `execute_sql` tool.
```

## The state machine

`rooms.status`: `lobby → in_progress → finished`.
`matches.status` (per duel): `pending → betting → active → finished`.

The room's `current_match_id` always points at the one duel currently in
`betting`/`active`/`finished`; every other match is `pending` (not started)
or already `finished`. `RoomView.tsx` reads exactly these two fields to
decide what screen to show — there is no separate client-side routing state
to keep in sync.

Owner-gated transitions (all check `is_owner` server-side, not just
client-side): `start_game`, `lock_betting`, `next_round`, `set_room_options`.
`next_round` is the deliberate pause between a duel finishing and the next
one opening for betting — added specifically so the table has time to read
the result and actually drink before the game moves on; the very first
version of `start_game`/settlement auto-advanced instantly and that was
wrong (see `0006_next_round.sql`'s commit message).

`advance_match` is the per-question state pump: idempotent, callable by any
client in the room (not just duellists), and only actually does something
once both duellists have answered or the deadline has passed. This is
intentional — it means the game keeps moving even if the current asker's
phone locks or drops the websocket, because every device polling
`get_current_question` also calls `advance_match` on the same interval (see
`Quiz.tsx`).

## Themes (added after the initial build)

Every duel draws its 10 questions from one of 8 categories: Sport, Geography,
Music, Celebrities, Film & TV, History, Science & Nature, Random Facts
(~100 questions each, 807 total). The category lives in `match_themes`, a
separate table with **no client grants at all** — not even read access — for
the reason spelled out above: `matches` is client-readable over Realtime, so
a category column there would leak a "mystery" theme instantly.

`get_match_theme(match_id)` is the only way a client learns a duel's theme.
The reveal rule: always shown once a duel is `active`; before that (`pending`
or `betting`), shown only if the room's `mystery_themes` flag is `false`
(the default). The host toggles it from the lobby via `set_room_options`,
which is lobby-only and owner-only.

## Environment & credentials

- `.env.local` (gitignored) / `.env.example` (committed, safe — see below)
  hold `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- The publishable key is meant to be public. It ships inside the deployed JS
  bundle regardless of what's in the repo, so committing it to
  `.env.example` leaks nothing new — it was already public. Verified this
  explicitly at one point: calling the REST API directly with just this key
  returns `permission denied` on every table.
- **There is no service-role key anywhere in this repo, its history, or CI.**
  If you ever find yourself wanting one to "make a script easier," stop —
  the intended path for schema changes is the Supabase MCP `apply_migration`
  tool, not a service-role-authenticated script.
- GitHub repo variables (not secrets — same public-safe reasoning) hold the
  same two values for the CI build: `gh variable list -R BaloghDaniel/betquiz`.

## Deployment specifics worth knowing

- `vite.config.ts` sets `base: '/betquiz/'` — required for GitHub Pages
  project sites. If you ever rename the repo, this must change too, along
  with `index.html`'s icon paths and the PWA manifest's `start_url`/`scope`.
- Routing is `HashRouter`, specifically to avoid needing a `404.html` SPA
  fallback trick — GitHub Pages has no server-side rewrite rules.
- **GitHub Pages on a private repo requires a paid plan.** This was
  discovered the hard way: the user asked to make the repo private, which
  silently tore down the Pages site (`DELETE`-equivalent, not just hidden —
  confirmed via `GET /repos/.../pages` returning 404 afterward). Re-enabling
  Pages after flipping back to public requires an explicit
  `POST /repos/.../pages` call, not just waiting — the site does not come
  back on its own. If the user ever asks for private again, tell them this
  up front rather than doing it and discovering the outage together.
- The workflow guards on the two build variables being set and fails loudly
  (`::error::`) rather than silently deploying a broken bundle if they're
  missing.

## Things NOT to reach for

- **No `psql`, no Supabase CLI, no local Postgres** are installed in this
  environment. All schema work goes through the Supabase MCP tools
  (`apply_migration`, `execute_sql`, `list_migrations`, `get_advisors`). Don't
  suggest `supabase db push` or similar — it won't be there.
- **No browser automation** is available in this environment either. UI
  changes are typechecked and built (`npm run build`), but nobody has visually
  confirmed layout/feel in this environment specifically — that verification
  happened outside these sessions, by the user directly loading the dev
  server or the live site. Say so explicitly rather than claiming a UI change
  "works" — you've confirmed it compiles and the logic is right, not that it
  looks right.
- **`gh` CLI is authenticated as `BaloghDaniel`** with `repo` + `workflow`
  scopes. Destructive git/gh operations (force-push, repo visibility changes,
  deleting branches) should still be confirmed with the user first per
  standard practice — the Pages-outage incident above is exactly the kind of
  surprising side effect that justifies asking first.

## User preferences observed this session

- Wants real verification, not claimed verification — the back-and-forth
  that found both bugs above happened because a full client-driven test was
  run and its output actually read, not because it was assumed to pass.
  Keep doing that for schema changes.
- Prefers direct execution over asking permission for routine steps (e.g.
  running migrations, writing test scripts) but explicitly said to ask
  before setup steps with real-world side effects (GitHub auth, repo
  visibility).
- Design decisions were resolved by giving 2-4 concrete options with tradeoffs
  rather than open-ended questions — worked well for settling the game rules,
  the category list, and the mystery-themes hybrid design (the user
  explicitly asked for a hybrid of two offered options: theme visible by
  default, host-toggleable to hidden-until-lock — don't assume either
  extreme is what's wanted next time this kind of choice comes up).
- Branch is `master`, not `main` — asked for explicitly, don't "fix" it back.
