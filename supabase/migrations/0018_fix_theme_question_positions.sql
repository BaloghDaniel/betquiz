-- Fix broken `position` values assigned when drawing a duel's themed questions.
--
-- start_game (0009) drew questions with:
--   select id, row_number() over () - 1 as rn
--   from questions where category = t.category
--   order by random() limit v_qpm
--
-- row_number() OVER () with no ORDER BY inside the window is numbered in
-- whatever order Postgres happens to produce rows in -- which is decided
-- *before* the outer ORDER BY random() / LIMIT is applied. So the stored
-- `position` values came out scattered (11, 17, 37, 49, ...) instead of 0..9.
-- lock_betting always starts a duel at current_position = 0, and no row ever
-- had position = 0, so get_current_question returned nothing and the duel
-- could never be played. Caught by scripts/e2e.mjs going through the real
-- client -- the SQL-level test that exercised this migration ran as postgres
-- and only checked "10 questions per match" and "no cross-match repeats",
-- neither of which the bug broke.
--
-- Fix: rank each match's candidate questions with `row_number() over
-- (partition by match order by random())`, which Postgres guarantees is
-- computed in the ORDER BY's order, then keep only positions < v_qpm. No
-- separate ORDER BY / LIMIT stage to get out of sync with.

create or replace function public.start_game(p_room_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player   public.players;
  v_room     public.rooms;
  v_count    int;
  v_matches  int;
  v_qpm      int;
  v_cats     int;
  v_first    uuid;
begin
  v_player := public.bq_require_player(p_room_id);
  if not v_player.is_owner then
    raise exception 'only the room owner can start the game';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if v_room.status <> 'lobby' then
    raise exception 'the game has already started';
  end if;

  select count(*) into v_count from public.players where room_id = p_room_id;
  if v_count < 2 then
    raise exception 'you need at least 2 players';
  end if;

  v_qpm     := v_room.questions_per_match;
  v_matches := v_count / 2;

  with shuffled as (
    select id, row_number() over (order by random()) - 1 as rn
    from public.players
    where room_id = p_room_id
  )
  insert into public.matches (room_id, match_index, player1_id, player2_id, status)
  select
    p_room_id,
    a.rn / 2,
    a.id,
    b.id,
    case when a.rn / 2 = 0 then 'betting' else 'pending' end
  from shuffled a
  join shuffled b on b.rn = a.rn + 1
  where a.rn % 2 = 0;

  -- Only themes with enough questions to fill a duel are eligible, so a
  -- half-populated bank degrades gracefully instead of failing to start.
  with cats as (
    select category, row_number() over (order by random()) - 1 as rn
    from (
      select category
      from public.questions
      where language = 'en'
      group by category
      having count(*) >= v_qpm
    ) c
  ),
  n as (select count(*)::int as total from cats)
  insert into public.match_themes (match_id, category)
  select m.id, c.category
  from public.matches m
  cross join n
  join cats c on c.rn = m.match_index % n.total
  where m.room_id = p_room_id;

  select count(*) into v_cats from public.match_themes t
  join public.matches m on m.id = t.match_id
  where m.room_id = p_room_id;

  if v_cats < v_matches then
    raise exception 'not enough themes have % or more questions yet', v_qpm;
  end if;

  -- Rank every question in each match's theme by a per-match random order,
  -- then keep the top v_qpm. The ORDER BY lives inside the window spec, so
  -- Postgres numbers rows in that exact order -- there is no later ORDER BY
  -- / LIMIT stage that could re-sort out from under the assigned positions.
  insert into public.match_questions (match_id, question_id, position)
  select match_id, question_id, rn
  from (
    select
      m.id as match_id,
      q.id as question_id,
      row_number() over (partition by m.id order by random()) - 1 as rn
    from public.matches m
    join public.match_themes t on t.match_id = m.id
    join public.questions q
      on q.language = 'en' and q.category = t.category
    where m.room_id = p_room_id
  ) ranked
  where rn < v_qpm;

  select id into v_first
  from public.matches
  where room_id = p_room_id and match_index = 0;

  update public.rooms
    set status = 'in_progress', current_match_id = v_first
    where id = p_room_id;

  return json_build_object('match_count', v_matches, 'current_match_id', v_first);
end;
$$;
