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
- **Function grants are as important as table grants, and the default runs the
  wrong way.** `0003_rls.sql` does `revoke execute on all functions in schema
  public from public, anon, authenticated` and then re-grants only the RPCs the
  app calls. That line reads like a standing policy. **It is not — it is a
  point-in-time snapshot of the functions that existed in `0003`.** Postgres
  grants `EXECUTE` to `PUBLIC` by default on every newly created function, so
  anything added in a later migration is **client-callable the moment it is
  created** unless that migration revokes it explicitly.

  So every new function needs a deliberate decision, in *both* directions:
  - a real RPC → `revoke ... from public, anon` then
    `grant execute ... to authenticated`;
  - an internal helper only other `SECURITY DEFINER` functions call →
    `revoke execute ... from public, anon, authenticated`. Writing a comment
    saying it is internal does not make it internal.

  This is not hypothetical in either direction. `0008` is the "forgot to grant"
  half (below). `0026` is the "forgot to revoke" half: `0021` ends with a comment
  stating `bq_dev_reset` and `bq_bot_answers` "stay internal", but never revoked
  them, so both were callable by any signed-in client until it was caught by
  auditing `has_function_privilege('authenticated', ...)` against the live
  database rather than reading the migrations. Reading the migrations is what
  hides it — the exposure is in what they *don't* say.

  To audit the real state at any time:

  ```sql
  select p.proname, pg_get_function_identity_arguments(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  order by 1;
  ```

  Everything it lists is client-callable surface area. It should contain the
  RPCs in `src/lib/api.ts`, plus `bq_is_member` / `bq_is_member_of_match`
  (required by the RLS policies — see below), and nothing else.

If you're about to add a table or a column that a client will read directly
(as opposed to through an RPC), ask: **could a hostile client abuse read
access to this the moment betting opens or a duel starts?** If yes, it needs
to go through an RPC instead, the way `match_themes` did.

## The database at a glance

Eleven tables. The "client" column is what `anon`/`authenticated` can do
**directly** over PostgREST; everything else is reached only through RPCs.
"Realtime" means the table is in the `supabase_realtime` publication and
therefore pushes changes to every subscribed phone.

| table | client | realtime | what it holds |
| --- | --- | --- | --- |
| `rooms` | SELECT | yes | code, owner, status, `current_match_id`, house rules (`questions_per_match`, `seconds_per_question`, `max_bet`, `penalty_mouthfuls`, `reveal_seconds`), `mystery_themes`, `is_dev` |
| `players` | SELECT | yes | room membership: nickname, `is_owner`, `is_bot`, `bot_skill`, nullable `user_id` |
| `matches` | SELECT | yes | the duels: pairing, `match_index`, status, scores, winner, `reveal_until` |
| `bets` | SELECT | yes | one row per bettor per match: who they backed, stake |
| `drinks` | SELECT | yes | the payout ledger: player, mouthfuls, `reason` (`lost_bet` / `quiz_loss`) |
| `questions` | **none** | no | the bank — 807 rows, `correct_index` lives here |
| `match_questions` | **none** | no | the 10 drawn per duel: `position` 0–9, `asked_at`, `deadline` |
| `answers` | **none** | no | submitted answers, graded server-side |
| `match_themes` | **none** | no | `category_a` / `category_b` candidates and the rolled `category` |
| `room_activity` | **none** | **no** | heartbeat timestamp per room, for the cleanup sweep |

The five "none" tables are the whole anti-cheat story: reading any of them
early would reveal an answer, a hidden theme, or an opponent's response.
`room_activity` is unreadable for a different reason — see the cleanup section
on why it is deliberately kept out of Realtime.

**RPC surface** (everything `authenticated` may call — mirrors `src/lib/api.ts`):

`create_room` · `join_room` · `leave_room` · `remove_player` · `start_game` ·
`set_room_options` · `place_bet` · `lock_betting` · `get_match_theme` ·
`get_current_question` · `submit_answer` · `advance_match` · `next_round` ·
`get_match_results` · `get_leaderboard` · `touch_room` · `dev_start_round`

Plus `bq_is_member` / `bq_is_member_of_match`, which are callable **on purpose**
because the RLS policies invoke them (see bug 1 below).

Internal, never client-callable: `bq_settle_match`, `bq_require_player`,
`bq_dev_reset`, `bq_bot_answers`, `bq_cleanup`.

## Bugs worth learning from

The first two were caught by `scripts/e2e.mjs`, **not** by testing directly in the SQL
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

3. **The over-permission blind spot** (`0026`, described under function grants
   above). Worth calling out separately because of *how* it had to be found: a
   passing test suite says nothing about it. Tests exercise the things the app
   is supposed to do, so they catch permissions that are too **tight** — a
   missing grant fails loudly on the next call. A permission that is too
   **loose** breaks nothing and every test still passes; `bq_dev_reset` and
   `bq_bot_answers` were callable by any client through every green run of both
   suites. The only way to see it is to ask the live database who can call what
   (the `has_function_privilege` query above) and compare that list against
   `src/lib/api.ts`. Do that after adding any function, and treat a mismatch as
   a bug even when nothing is visibly broken.

## Architecture map

```
src/
  lib/supabase.ts       Supabase client + ensureSignedIn() (anonymous auth),
                        plus the stale-session recovery helpers
  lib/api.ts            Every RPC call, one function each — this is the entire
                        client→server surface. If it's not here, the client
                        can't do it. Its rpc() wrapper also catches the
                        orphaned-JWT case and re-authenticates once.
  lib/types.ts          TS types mirroring RPC JSON shapes
  hooks/useRoom.ts      Single Realtime subscription per room; refetches room
                        state wholesale on any change rather than merging
                        deltas (simplicity over bytes, deliberate for a party
                        game's scale). Also owns two intervals: a 10s safety
                        net and the 30s touch_room heartbeat — see the
                        cleanup section, the heartbeat is load-bearing.
  routes/               Home (create/join), RoomView (state-machine dispatch)
  components/
    Lobby, Betting, Quiz, RoundResult, Leaderboard
                        One per room/match status. RoomView switches between
                        them purely off `room.status` and
                        `currentMatch.status`, keyed by match id so each duel
                        gets fresh local state.
    ThemeReveal         The slot-machine flip between the two candidate
                        themes, then the held reveal listing every bet.
                        Driven by `matches.reveal_until`, not a local timer.
    Screen              Shared page shell. `home` prop renders the "← Home"
                        link, which is client-side nav only — it deliberately
                        does NOT call leave_room, so you keep your seat.
    ErrorBoundary       Wraps the app so a render-time throw shows a message
                        and a way out instead of a blank page. Added after a
                        blank screen turned out to be undiagnosable from the
                        browser (see below).
    DevRoundPicker      The sandbox's play-or-bet choice, dev rooms only.

supabase/migrations/    Applied in numeric order via the Supabase MCP
                        `apply_migration` tool (no local Postgres, no
                        `psql`, no service-role key in this environment —
                        migrations are the only way schema changes happen).
                        See the table in README.md for what each one does.
                        Keep the repo and the database in step: write the
                        file *and* apply it. `0024` was applied without ever
                        being written down, which left the repo unable to
                        rebuild the database from scratch until it was
                        recovered out of `supabase_migrations.schema_migrations`.

scripts/e2e.mjs         The test that matters most. Full game through the
                        real client SDK: anon auth, anti-cheat table-read
                        checks, betting rules, a complete themed duel,
                        mystery-themes reveal timing, leaderboard. Run before
                        trusting any schema change. `npm run test:e2e`.
scripts/dev-room-check.mjs
                        The 111111 sandbox end to end, both round modes.
                        `npm run test:dev-room`. Run this too — it is the only
                        coverage of the bot paths.
```

Both scripts print a `CLEANUP=` / `CLEANUP_IDS=` line of the exact user ids they
created. Delete those by id (see the warning below); the scheduled sweep will
also get them eventually.

### NEVER blanket-delete anonymous users

**Do not run `delete from auth.users where is_anonymous = true;`.** Every real
player is an anonymous user — that is the entire auth model. This deletes the
accounts of anyone currently playing, on their phone, mid-game.

It fails in a maximally confusing way. Their browser keeps a persisted JWT that
is still correctly signed and unexpired, so the app looks fine and `auth.uid()`
returns a normal-looking id — but the row behind it is gone, so the next write
dies on `players_user_id_fkey` and the player sees a raw Postgres foreign-key
error when trying to join a room. (This happened. An earlier version of this
very file recommended that command, which is how.)

To clean up after `npm run test:e2e`, delete the specific ids it prints on the
last line (`CLEANUP_IDS=...`):

```sql
delete from auth.users where id in ('...','...');
```

If you need a broader sweep, at minimum protect anyone who could still be
playing — old accounts, and only those not in a live room:

```sql
delete from auth.users u
where u.is_anonymous = true
  and u.created_at < now() - interval '6 hours'
  and not exists (
    select 1 from public.players p
    join public.rooms r on r.id = p.room_id
    where p.user_id = u.id and r.status <> 'finished'
  );
```

The client now self-heals from this (`ensureSignedIn` verifies the stored
session with `getUser()` instead of trusting localStorage, and `rpc()` retries
once after re-authenticating), but self-healing means the player silently
becomes a *new* identity and loses their seat in any room they were in. Prevention
still matters.

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

## The colour system

All colour lives in the `@theme` block at the top of `src/index.css`. There are
no hardcoded hex values and no borrowed Tailwind palette colours (`red-500`,
`slate-300`, …) anywhere in the app — if you need a colour, it is one of these
tokens or it is a mistake.

The palette went through several rounds with the user and is currently **light**:
a near-white ground with saturated fills. The user's stated brief was "party but
somewhat professional", and — stated explicitly — **no yellow and no purple**.
Earlier versions were dark-on-plum with a yellow accent; don't drift back.

| token | value | role |
| --- | --- | --- |
| `canvas` | `#eef2f7` | the page |
| `surface` | `#ffffff` | cards, inputs |
| `line` | `#d6dfea` | borders, tracks |
| `ink` | `#10253a` | **all** text (13.9:1 on canvas) |
| `accent` / `accent-deep` | `#00a6d6` / `#00668a` | cyan — room code, winners, timers |
| `mint` / `mint-deep` | `#12b981` / `#05714b` | green — right answers, winning bets |
| `coral` / `coral-deep` | `#fb4d5c` / `#c21f32` | red — drinks owed, lost bets, errors |
| `blue` | `#1b3f8b` | navy anchor, filled surfaces |

Four rules, all of which exist because a light ground behaves the opposite way
to the dark one this app used to have. Getting any of them wrong produces
something that looks fine on your screen and is unreadable in a pub.

1. **Every hue has two weights, and they are not interchangeable.** A colour
   bright enough to be exciting as a filled block is far too light to read as
   text on white — plain `accent` on `canvas` is 2.5:1. So `bg-accent`, and
   `text-accent-deep`. The bare token is for fills, the `-deep` twin is for text
   and for anything thin (a 1.5px progress bar needs 3:1 against its track, which
   the bright fills miss and the deep ones clear).
2. **Text on a bright fill is `ink`, never white.** White on cyan/green/red is
   2.5–3.3:1; ink is 4.7–6.2:1. `blue` is the sole exception and inverts it:
   white on blue is 9.9:1, ink on blue is 1.6:1.
3. **Muted text is `ink` at reduced alpha** (`text-ink/50`, `/60`, `/70`), not a
   second grey token. Stay on multiples of 5 — Tailwind ships that opacity scale
   and off-scale values risk being dropped at build time. `/50` is roughly the
   floor for anything you actually expect to be read.
4. **Never fade a neutral to suggest a surface.** On the old dark ground
   `bg-surface/60` made a panel that was *lighter* than the page. On a light
   ground the same class fades toward the page and the panel vanishes
   (`canvas` on `surface` is 1.12:1). Panels are solid: `bg-surface` on the
   canvas, `bg-canvas` for a recess inside a card. Tinted *party* fills at low
   alpha (`bg-coral/10`, `bg-accent/20`) are fine and still take `ink` text —
   those read as a wash of colour, which is the point.

The one place white is still correct is the mystery-themes toggle knob, and it
needs its shadow to be visible at all — a white knob on a border-weight grey is
1.35:1.

If you change any of this, check the numbers rather than eyeballing them; the
values above were picked by computing WCAG ratios for every fill/text pairing,
not by taste.

Three things outside `index.css` carry colour too, and all of them were missed
once already:

- **PWA chrome** — `theme_color` and `background_color` in `vite.config.ts`, and
  `theme-color` in `index.html`, all carry the canvas colour. `index.html` also
  sets `apple-mobile-web-app-status-bar-style` to `default` rather than
  `black-translucent`, because translucent draws the iOS clock in white: right
  over the old dark ground, invisible over this one.
- **The app icons** — `public/icon-192.png`, `icon-512.png`,
  `apple-touch-icon.png`. Regenerate with `node scripts/make-icons.mjs`, which
  draws the mark from constants copied out of the `@theme` block. It writes PNGs
  by hand through `zlib` because there is no ImageMagick, rsvg, Pillow or canvas
  library in this environment — do not reach for one, and do not hand-edit the
  PNGs. Icons are easy to forget and the stalest possible artefact: the icon
  stayed dark-plum-and-yellow through an entire palette change, which is the
  literal reason that script exists.
- **Nothing else.** There are no hex values anywhere in `src/` outside
  `index.css`, and no borrowed Tailwind palette colours anywhere at all. Both are
  worth re-checking with a grep after any colour work, since either one silently
  breaks the ability to restyle the app from one place.

## Themes (added after the initial build)

Every duel draws its 10 questions from one of 8 categories: Sport, Geography,
Music, Celebrities, Film & TV, History, Science & Nature, Random Facts
(~100 questions each, 807 total). Themes live in `match_themes`, a separate
table with **no client grants at all** — not even read access — for the reason
spelled out above: `matches` is client-readable over Realtime, so a category
column there would leak a hidden theme instantly.

**Two candidates, rolled after betting closes** (`0020_theme_showdown.sql`).
`start_game` assigns each duel two candidates (`category_a`, `category_b`) and
draws *no* questions. `lock_betting` rolls the winner into `category`, draws
that theme's questions, and sets `matches.reveal_until = now() + reveal_seconds`.

The roll deliberately happens at lock time rather than at `start_game`. Both are
equally leak-proof (nothing client-readable either way), but rolling after the
bets are in means there is no predetermined outcome in existence to leak. The
practical consequence: **a duel has no rows in `match_questions` until its
`lock_betting` runs.** Anything asserting questions exist right after
`start_game` is wrong under the current design.

Two guards protect the reveal window, both load-bearing:
- `get_current_question` returns `revealing: true` and **withholds prompt and
  options** until `reveal_until` passes. A duellist who could read the question
  during the animation would get free thinking time.
- `submit_answer` rejects anything sent before `match_questions.asked_at`.
- The first question's `asked_at`/`deadline` are stamped *from* `reveal_until`,
  so the reveal never eats into answering time. Lengthening `reveal_seconds`
  costs nobody a second of their 20.

`get_match_theme(match_id)` is the only way a client learns any of this. It
returns `candidates` during betting and `category` once rolled; under the room's
`mystery_themes` flag it hides the candidates too, so bets are placed blind. The
host toggles that from the lobby via `set_room_options` (lobby-only, owner-only).

Because a duel now pauses on a reveal, `scripts/e2e.mjs` has a `waitForReveal()`
helper. Any new test that calls `lock_betting` and then expects a question must
use it, or it will get the sealed reveal payload and fail confusingly (the
symptom is `submit_answer` being called with an undefined `match_question_id`).

## The 111111 sandbox

Joining with the code `111111` gives a single-player room containing you and
two bots (`0021_dev_room.sql`), for exercising the whole chain without needing
a room full of people. `npm run test:dev-room` covers it end to end.

Three players is the point: `floor(3/2)` = one duel plus one spectator, so
`dev_start_round(room, 'play')` pairs you with a bot and leaves the other
betting, and `'bet'` pairs the two bots and leaves you betting. Both sides of
the game are reachable solo by flipping one choice, and you pick again after
every round rather than being locked into a bracket.

Things that are easy to get wrong here:

- **Bots have `user_id = null` and `is_bot = true`.** They have no auth
  identity and never call an RPC -- the server plays them from inside
  `advance_match` (via `bq_bot_answers`) and `dev_start_round`. This keeps them
  out of RLS entirely, since `bq_is_member` matches `user_id = auth.uid()`,
  which null can never satisfy. A `players_user_or_bot` check constraint
  enforces the pairing of those two columns.
- **Bot decisions are deterministic per (question, bot)**, seeded from
  `hashtext(match_question_id || player_id)`. They must be: `advance_match` is
  polled every ~700ms by every client, so a bot rolling fresh randomness each
  call would flip its answer and its think-time on every poll.
- **Bots deliberately wait 2-5 seconds** before answering, so a bot-vs-bot duel
  is watchable instead of resolving the instant the question opens.
- `join_room` special-cases the code and **resets the room on every join** --
  fresh lobby, previous rounds wiped. Two people using it at once would clobber
  each other; it is a dev tool, not a room.
- The room is **self-healing**: if it gets deleted (e.g. its owner's auth user
  is removed, which cascades), the next join recreates it. Verified.
- `dev_start_round` refuses to run against a room without `is_dev`, so the
  sandbox cannot be used as a lever on a real game.

## Scheduled cleanup (pg_cron)

A `pg_cron` job named `betquiz-cleanup` runs `public.bq_cleanup()` every 5
minutes (`0023`–`0025`). It deletes rooms idle for 10 minutes and anonymous
users attached to no room and older than 30 minutes. Inspect it with
`select * from cron.job` / `cron.job_run_details`; both intervals are function
parameters if they need tuning.

The user asked for 10 minutes on both rooms and users. Rooms are exactly that.
For users the gate is deliberately *attachment* rather than age — anyone in a
room is untouchable no matter how old their account is — and the 30 minutes only
avoids catching someone who signed in seconds ago and has not typed a room code
yet. Worth re-confirming if it ever comes up rather than silently keeping it.

**The client heartbeat is load-bearing.** `useRoom` calls `touch_room` every 30
seconds, which stamps `room_activity`. Without it a room being actively played
looks idle — `players.last_seen` is only written on join, and nothing else
writes a timestamp during a duel — so the sweep would delete rooms out from
under people mid-game. If you ever change or remove that heartbeat, change the
cleanup with it.

`room_activity` is deliberately **not** in the `supabase_realtime` publication,
and the heartbeat deliberately does not live on `rooms`. `rooms` is published,
and `useRoom` refetches the entire room on any change, so a heartbeat there
would broadcast to every device every 30s purely to record "still here".

**`auth.users` cascades to `rooms` via `rooms_owner_id_fkey`.** Deleting a user
silently deletes their rooms. The user sweep therefore skips anyone who has a
`players` row *or* owns a room. Testing caught this: the ownership check was
initially missing, and a room whose owner held no players row was destroyed by
the cascade. The two checks are equivalent today (create_room and bq_dev_reset
both seat the owner) but nothing enforces that, so both are checked.

Related: never clean up test users with a blanket delete — see the warning
above about `is_anonymous = true`.

## Git workflow — do not commit or push without being asked

**Do not run `git commit` or `git push` unless the user explicitly asks for
it in that turn.** Earlier sessions committed and pushed after every change
by default; the user corrected this and wants local changes to sit
uncommitted until they actively ask for a commit. This applies even to
small, obviously-correct fixes — don't rationalize an exception.

What this means in practice:
- Make the edits, run the build/tests, verify things work — all of that is
  still expected without being asked.
- Leave the working tree dirty. Report what changed and that it's ready to
  commit, rather than committing it.
- Database migrations applied via the Supabase MCP tools are a separate
  question from git — those go live on `apply_migration` regardless (there's
  no "staged but not applied" state for a migration), so continue applying
  schema changes as needed to verify them. It's specifically the *repo* —
  `git commit` / `git push` — that waits for an explicit ask.
- If the user says something like "looks good" or "ship it" without the
  words commit/push, that's still ambiguous — ask, don't assume.

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

## User preferences

- Wants real verification, not claimed verification — the back-and-forth
  that found both bugs above happened because a full client-driven test was
  run and its output actually read, not because it was assumed to pass.
  Keep doing that for schema changes.
- Prefers direct execution over asking permission for routine steps (e.g.
  running migrations, writing test scripts) but explicitly said to ask
  before setup steps with real-world side effects (GitHub auth, repo
  visibility) — **and, as of this correction, before any `git commit` /
  `git push`.** See "Git workflow" above; that section is the current rule,
  this bullet is the history of how it was arrived at.
- Design decisions were resolved by giving 2-4 concrete options with tradeoffs
  rather than open-ended questions — worked well for settling the game rules,
  the category list, and the mystery-themes hybrid design (the user
  explicitly asked for a hybrid of two offered options: theme visible by
  default, host-toggleable to hidden-until-lock — don't assume either
  extreme is what's wanted next time this kind of choice comes up).
- Branch is `master`, not `main` — asked for explicitly, don't "fix" it back.
- **Colour has been iterated on repeatedly and the user has clear taste.** The
  progression was: default dark → a muted blue/grey set they found flat → a
  brighter "party" set on a dark plum ground → lightening that ground → and
  finally the light scheme documented above, with "no yellow, no purple" said
  explicitly. Treat that as a standing constraint, not a one-off instruction.
  They respond well to being given a palette and a short explanation of why
  each colour got the role it did.
- Asks for the "why", not just the change — the sections in this file exist
  because the user asked for reasoning to be written down for future sessions.
  When something non-obvious gets decided, it belongs here.
