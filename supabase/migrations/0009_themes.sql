-- Give every duel a theme, optionally kept secret until the betting closes.
--
-- The theme lives in its own table rather than as a column on `matches`,
-- because clients can read `matches` directly (and receive it over Realtime).
-- A category column there would hand the "mystery" theme straight to anyone
-- with devtools open. match_themes has no client grants at all; the reveal rule
-- is enforced by get_match_theme.

-- --------------------------------------------------------------------------
-- Consolidate to the eight themes.
-- --------------------------------------------------------------------------
update public.questions set category = 'Geography'        where category = 'geography';
update public.questions set category = 'Science & Nature' where category = 'science';
update public.questions set category = 'Music'            where category = 'music';
update public.questions set category = 'Film & TV'        where category = 'film';
update public.questions set category = 'Sport'            where category = 'sport';
update public.questions set category = 'History'          where category = 'history';
-- Food & drink stops being its own theme; those questions are good general
-- trivia, so they join Random Facts rather than being thrown away.
update public.questions set category = 'Random Facts'     where category in ('food', 'general');

alter table public.questions
  add constraint questions_category_check check (category in (
    'Sport', 'Geography', 'Music', 'Celebrities',
    'Film & TV', 'History', 'Science & Nature', 'Random Facts'
  ));

alter table public.questions alter column category drop default;

-- --------------------------------------------------------------------------
-- Room option + per-duel theme
-- --------------------------------------------------------------------------
alter table public.rooms
  add column mystery_themes boolean not null default false;

create table public.match_themes (
  match_id uuid primary key references public.matches (id) on delete cascade,
  category text not null
);

alter table public.match_themes enable row level security;
revoke all on public.match_themes from anon, authenticated;
-- No policies and no grants: readable only through get_match_theme.

create or replace function public.set_room_options(
  p_room_id        uuid,
  p_mystery_themes boolean
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.players;
  v_room   public.rooms;
begin
  v_player := public.bq_require_player(p_room_id);
  if not v_player.is_owner then
    raise exception 'only the room owner can change the settings';
  end if;

  select * into v_room from public.rooms where id = p_room_id;
  if v_room.status <> 'lobby' then
    raise exception 'settings are locked once the game has started';
  end if;

  update public.rooms
    set mystery_themes = coalesce(p_mystery_themes, false)
    where id = p_room_id;

  return json_build_object('mystery_themes', coalesce(p_mystery_themes, false));
end;
$$;

-- The theme is public during betting unless the room is playing with mystery
-- themes on, in which case it stays sealed until the duel actually starts.
create or replace function public.get_match_theme(p_match_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match    public.matches;
  v_room     public.rooms;
  v_category text;
begin
  select * into v_match from public.matches where id = p_match_id;
  if not found then
    raise exception 'no such match';
  end if;

  perform public.bq_require_player(v_match.room_id);
  select * into v_room from public.rooms where id = v_match.room_id;
  select category into v_category from public.match_themes where match_id = p_match_id;

  if v_room.mystery_themes and v_match.status in ('pending', 'betting') then
    return json_build_object('revealed', false, 'category', null);
  end if;

  return json_build_object('revealed', true, 'category', v_category);
end;
$$;

revoke execute on function public.set_room_options(uuid, boolean) from public, anon;
revoke execute on function public.get_match_theme(uuid)           from public, anon;
grant  execute on function public.set_room_options(uuid, boolean) to authenticated;
grant  execute on function public.get_match_theme(uuid)           to authenticated;

-- --------------------------------------------------------------------------
-- start_game now assigns a theme per duel and draws only from that theme.
-- --------------------------------------------------------------------------
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

  -- Draw each duel's questions from its own theme. The lateral join re-runs the
  -- random pick per match, so two duels sharing a theme still get their own set.
  insert into public.match_questions (match_id, question_id, position)
  select m.id, q.id, q.rn
  from public.matches m
  join public.match_themes t on t.match_id = m.id
  cross join lateral (
    select id, row_number() over () - 1 as rn
    from public.questions
    where language = 'en' and category = t.category
    order by random()
    limit v_qpm
  ) q
  where m.room_id = p_room_id;

  select id into v_first
  from public.matches
  where room_id = p_room_id and match_index = 0;

  update public.rooms
    set status = 'in_progress', current_match_id = v_first
    where id = p_room_id;

  return json_build_object('match_count', v_matches, 'current_match_id', v_first);
end;
$$;
