-- Two candidate themes per duel, with the winner rolled after betting closes.
--
-- Betting now happens against a coin flip: the lobby sees two possible themes
-- and has to weigh both when backing a player. Once the host closes betting,
-- the server picks one at random, and every device plays a short randomiser
-- animation before revealing the winner alongside the bets on the table.
--
-- The roll deliberately happens in lock_betting, not start_game. Deciding it up
-- front and animating over a stored answer would work identically from the
-- outside (match_themes has no client grants, so nothing leaks either way), but
-- rolling after the bets are in means there is no predetermined result to leak
-- in the first place. It also means a duel's questions cannot be drawn until
-- its theme exists, so the draw moves out of start_game too.

-- --------------------------------------------------------------------------
-- Schema
-- --------------------------------------------------------------------------
alter table public.match_themes
  add column if not exists category_a text,
  add column if not exists category_b text;

-- `category` is now the *picked* theme and stays null until betting closes.
alter table public.match_themes alter column category drop not null;

-- Any duel already in flight keeps working: its decided theme becomes both
-- candidates, so a randomiser over it is a no-op rather than a crash.
update public.match_themes
  set category_a = coalesce(category_a, category),
      category_b = coalesce(category_b, category)
  where category_a is null or category_b is null;

-- When the reveal ends and the first question actually starts. The first
-- question's clock is stamped from this, so the reveal never eats into
-- answering time.
alter table public.matches
  add column if not exists reveal_until timestamptz;

alter table public.rooms
  add column if not exists reveal_seconds int not null default 5
    check (reveal_seconds between 0 and 30);

-- --------------------------------------------------------------------------
-- start_game: assign two candidates per duel, draw no questions yet
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
  v_themed   int;
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

  -- Two distinct candidates per duel, ranked per match so each duel gets its
  -- own draw. The ORDER BY lives inside the window spec on purpose -- see
  -- 0018 for what happens when it does not.
  insert into public.match_themes (match_id, category_a, category_b)
  select match_id,
         max(case when rn = 1 then category end),
         -- one eligible theme only: both candidates collapse to it
         coalesce(max(case when rn = 2 then category end),
                  max(case when rn = 1 then category end))
  from (
    select m.id as match_id, c.category,
           row_number() over (partition by m.id order by random()) as rn
    from public.matches m
    cross join (
      select category
      from public.questions
      where language = 'en'
      group by category
      having count(*) >= v_qpm
    ) c
    where m.room_id = p_room_id
  ) ranked
  where rn <= 2
  group by match_id;

  select count(*) into v_themed
  from public.match_themes t
  join public.matches m on m.id = t.match_id
  where m.room_id = p_room_id;

  if v_themed < v_matches then
    raise exception 'no theme has % or more questions yet', v_qpm;
  end if;

  select id into v_first
  from public.matches
  where room_id = p_room_id and match_index = 0;

  update public.rooms
    set status = 'in_progress', current_match_id = v_first
    where id = p_room_id;

  return json_build_object('match_count', v_matches, 'current_match_id', v_first);
end;
$$;

-- --------------------------------------------------------------------------
-- lock_betting: roll the theme, draw its questions, open the reveal window
-- --------------------------------------------------------------------------
create or replace function public.lock_betting(p_match_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match  public.matches;
  v_room   public.rooms;
  v_player public.players;
  v_theme  public.match_themes;
  v_picked text;
  v_reveal timestamptz;
  v_drawn  int;
begin
  select * into v_match from public.matches where id = p_match_id for update;
  if not found then
    raise exception 'no such match';
  end if;

  v_player := public.bq_require_player(v_match.room_id);
  if not v_player.is_owner then
    raise exception 'only the room owner can start the round';
  end if;

  if v_match.status = 'active' then
    return json_build_object('status', 'active');  -- idempotent
  end if;

  if v_match.status <> 'betting' then
    raise exception 'this round cannot be started';
  end if;

  select * into v_room  from public.rooms        where id = v_match.room_id;
  select * into v_theme from public.match_themes where match_id = p_match_id;

  -- The roll. Bets are already in and can no longer be changed.
  v_picked := case when random() < 0.5 then v_theme.category_a else v_theme.category_b end;
  v_picked := coalesce(v_picked, v_theme.category_a, v_theme.category_b);

  update public.match_themes set category = v_picked where match_id = p_match_id;

  -- Draw this duel's questions from the theme that just won.
  insert into public.match_questions (match_id, question_id, position)
  select p_match_id, question_id, rn
  from (
    select q.id as question_id,
           row_number() over (order by random()) - 1 as rn
    from public.questions q
    where q.language = 'en' and q.category = v_picked
  ) ranked
  where rn < v_room.questions_per_match
  on conflict do nothing;

  select count(*) into v_drawn from public.match_questions where match_id = p_match_id;
  if v_drawn < v_room.questions_per_match then
    raise exception 'theme "%" does not have enough questions', v_picked;
  end if;

  -- The reveal runs before the first question's clock starts, so nobody loses
  -- answering time to the animation.
  v_reveal := now() + make_interval(secs => v_room.reveal_seconds);

  update public.matches
    set status = 'active',
        started_at = now(),
        current_position = 0,
        reveal_until = v_reveal
    where id = p_match_id;

  update public.match_questions
    set asked_at = v_reveal,
        deadline = v_reveal + make_interval(secs => v_room.question_seconds)
    where match_id = p_match_id and position = 0;

  return json_build_object('status', 'active', 'reveal_until', v_reveal);
end;
$$;

-- --------------------------------------------------------------------------
-- get_match_theme: expose both candidates, and the winner once it is known
-- --------------------------------------------------------------------------
create or replace function public.get_match_theme(p_match_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match  public.matches;
  v_room   public.rooms;
  v_theme  public.match_themes;
  v_hidden boolean;
begin
  select * into v_match from public.matches where id = p_match_id;
  if not found then
    raise exception 'no such match';
  end if;

  perform public.bq_require_player(v_match.room_id);
  select * into v_room  from public.rooms        where id = v_match.room_id;
  select * into v_theme from public.match_themes where match_id = p_match_id;

  -- Mystery themes hides the candidates too: you bet knowing nothing at all.
  v_hidden := v_room.mystery_themes and v_match.status in ('pending', 'betting');

  return json_build_object(
    'revealed',   v_theme.category is not null,
    'category',   v_theme.category,
    'mystery',    v_hidden,
    'candidates',
      case
        when v_hidden then null
        else json_build_array(v_theme.category_a, v_theme.category_b)
      end
  );
end;
$$;

-- --------------------------------------------------------------------------
-- get_current_question: hold the question back until the reveal is over
-- --------------------------------------------------------------------------
create or replace function public.get_current_question(p_match_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match   public.matches;
  v_room    public.rooms;
  v_player  public.players;
  v_theme   public.match_themes;
  v_mq      public.match_questions;
  v_q       public.questions;
  v_total   int;
  v_prev    json := null;
  v_my_ans  json := null;
begin
  select * into v_match from public.matches where id = p_match_id;
  if not found then
    raise exception 'no such match';
  end if;

  v_player := public.bq_require_player(v_match.room_id);
  select * into v_room  from public.rooms        where id = v_match.room_id;
  select * into v_theme from public.match_themes where match_id = p_match_id;

  select count(*) into v_total from public.match_questions where match_id = p_match_id;

  if v_match.status <> 'active' then
    return json_build_object(
      'match_id', p_match_id,
      'status',   v_match.status,
      'total',    v_total
    );
  end if;

  -- Reveal window: the theme and the bets are on screen, the question is not.
  -- Withholding the prompt here is not cosmetic -- a duellist who could read it
  -- during the reveal would get free thinking time before the clock starts.
  if v_match.reveal_until is not null and now() < v_match.reveal_until then
    return json_build_object(
      'match_id',     p_match_id,
      'status',       'active',
      'revealing',    true,
      'reveal_until', v_match.reveal_until,
      'server_now',   now(),
      'category',     v_theme.category,
      'candidates',   json_build_array(v_theme.category_a, v_theme.category_b),
      'position',     v_match.current_position,
      'total',        v_total,
      'is_duellist',  v_player.id in (v_match.player1_id, v_match.player2_id),
      'p1_score',     v_match.p1_score,
      'p2_score',     v_match.p2_score
    );
  end if;

  select * into v_mq
  from public.match_questions
  where match_id = p_match_id and position = v_match.current_position;

  select * into v_q from public.questions where id = v_mq.question_id;

  if v_match.current_position > 0 then
    select json_build_object(
             'position',      pmq.position,
             'prompt',        pq.prompt,
             'options',       pq.options,
             'correct_index', pq.correct_index,
             'p1_correct',    coalesce(a1.is_correct, false),
             'p2_correct',    coalesce(a2.is_correct, false)
           )
      into v_prev
    from public.match_questions pmq
    join public.questions pq on pq.id = pmq.question_id
    left join public.answers a1
      on a1.match_question_id = pmq.id and a1.player_id = v_match.player1_id
    left join public.answers a2
      on a2.match_question_id = pmq.id and a2.player_id = v_match.player2_id
    where pmq.match_id = p_match_id and pmq.position = v_match.current_position - 1;
  end if;

  select json_build_object('selected_index', selected_index)
    into v_my_ans
  from public.answers
  where match_question_id = v_mq.id and player_id = v_player.id;

  return json_build_object(
    'match_id',     p_match_id,
    'match_question_id', v_mq.id,
    'status',       v_match.status,
    'revealing',    false,
    'position',     v_mq.position,
    'total',        v_total,
    'prompt',       v_q.prompt,
    'options',      v_q.options,
    'category',     v_q.category,
    'candidates',   json_build_array(v_theme.category_a, v_theme.category_b),
    'asked_at',     v_mq.asked_at,
    'deadline',     v_mq.deadline,
    'server_now',   now(),
    'is_duellist',  v_player.id in (v_match.player1_id, v_match.player2_id),
    'my_answer',    v_my_ans,
    'p1_answered',  exists (select 1 from public.answers
                            where match_question_id = v_mq.id and player_id = v_match.player1_id),
    'p2_answered',  exists (select 1 from public.answers
                            where match_question_id = v_mq.id and player_id = v_match.player2_id),
    'p1_score',     v_match.p1_score,
    'p2_score',     v_match.p2_score,
    'previous',     v_prev
  );
end;
$$;

-- --------------------------------------------------------------------------
-- submit_answer: refuse answers sent before the question has started
-- --------------------------------------------------------------------------
create or replace function public.submit_answer(
  p_match_question_id uuid,
  p_selected_index    int
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mq      public.match_questions;
  v_match   public.matches;
  v_player  public.players;
  v_correct int;
  v_is_ok   boolean;
begin
  select * into v_mq from public.match_questions where id = p_match_question_id;
  if not found then
    raise exception 'no such question';
  end if;

  select * into v_match from public.matches where id = v_mq.match_id;
  v_player := public.bq_require_player(v_match.room_id);

  if v_player.id not in (v_match.player1_id, v_match.player2_id) then
    raise exception 'you are not playing this round';
  end if;

  if v_match.status <> 'active' then
    raise exception 'this round is not in play';
  end if;

  if v_mq.position <> v_match.current_position then
    raise exception 'that question is no longer in play';
  end if;

  -- Closes the reveal-window hole: without this a duellist could answer while
  -- the theme animation is still playing, before the clock has started.
  if v_mq.asked_at is null or now() < v_mq.asked_at then
    raise exception 'this question has not started yet';
  end if;

  if v_mq.deadline is not null and now() > v_mq.deadline then
    raise exception 'time is up for this question';
  end if;

  if p_selected_index is null or p_selected_index not between 0 and 3 then
    raise exception 'pick one of the four options';
  end if;

  select correct_index into v_correct from public.questions where id = v_mq.question_id;
  v_is_ok := (v_correct = p_selected_index);

  insert into public.answers
    (match_question_id, player_id, selected_index, is_correct, ms_taken)
  values (
    p_match_question_id,
    v_player.id,
    p_selected_index,
    v_is_ok,
    greatest(0, extract(epoch from (now() - v_mq.asked_at)) * 1000)::int
  )
  on conflict (match_question_id, player_id) do nothing;

  return json_build_object('accepted', true);
end;
$$;
