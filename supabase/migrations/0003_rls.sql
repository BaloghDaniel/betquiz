-- Lock everything down.
--
-- Clients hold the public anon key, so the default posture here is "no access".
-- They get read-only SELECT on the five tables Realtime needs to drive the UI,
-- scoped to rooms they are actually in. They get no write access anywhere, and
-- no access at all to questions, match_questions or answers -- reading those
-- would hand a player the correct answers mid-duel.

alter table public.rooms           enable row level security;
alter table public.players         enable row level security;
alter table public.matches         enable row level security;
alter table public.questions       enable row level security;
alter table public.match_questions enable row level security;
alter table public.answers         enable row level security;
alter table public.bets            enable row level security;
alter table public.drinks          enable row level security;

-- Membership test used by the policies below. SECURITY DEFINER so that the
-- policy on `players` does not recurse into itself when it queries `players`.
create or replace function public.bq_is_member(p_room_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.players
    where room_id = p_room_id and user_id = auth.uid()
  );
$$;

create or replace function public.bq_is_member_of_match(p_match_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.matches m
    join public.players p on p.room_id = m.room_id
    where m.id = p_match_id and p.user_id = auth.uid()
  );
$$;

-- --------------------------------------------------------------------------
-- Blanket revoke, then hand back only read access on the live-state tables.
-- --------------------------------------------------------------------------
revoke all on public.rooms, public.players, public.matches, public.questions,
              public.match_questions, public.answers, public.bets, public.drinks
  from anon, authenticated;

grant select on public.rooms, public.players, public.matches,
                public.bets, public.drinks
  to authenticated;

-- questions / match_questions / answers: no grant at all. RPC access only.

create policy rooms_select_member on public.rooms
  for select to authenticated
  using (public.bq_is_member(id));

create policy players_select_member on public.players
  for select to authenticated
  using (public.bq_is_member(room_id));

create policy matches_select_member on public.matches
  for select to authenticated
  using (public.bq_is_member(room_id));

-- Open bets are visible to the whole room on purpose: seeing who backed whom
-- is half the fun.
create policy bets_select_member on public.bets
  for select to authenticated
  using (public.bq_is_member_of_match(match_id));

create policy drinks_select_member on public.drinks
  for select to authenticated
  using (public.bq_is_member(room_id));

-- --------------------------------------------------------------------------
-- Function grants.
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, which would let a client
-- call bq_settle_match directly and end a duel early. Revoke everything, then
-- re-grant only the RPCs that are meant to be called from the app.
-- --------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.create_room(text),
  public.join_room(text, text),
  public.leave_room(uuid),
  public.start_game(uuid),
  public.place_bet(uuid, uuid, int),
  public.lock_betting(uuid),
  public.get_current_question(uuid),
  public.submit_answer(uuid, int),
  public.advance_match(uuid),
  public.get_match_results(uuid),
  public.get_leaderboard(uuid)
  to authenticated;

-- bq_generate_code, bq_require_player, bq_settle_match, bq_is_member and
-- bq_is_member_of_match stay internal -- they are only ever called from inside
-- other SECURITY DEFINER functions and from RLS policies, which run as the
-- definer regardless of the caller's grants.
