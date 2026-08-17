-- BetQuiz game logic.
--
-- Every function here is SECURITY DEFINER and validates auth.uid() itself. The
-- client never writes to a table directly, so scores, winners and the drinks
-- ledger cannot be forged. Correct answers leave the database only via
-- get_match_results, and only once the match is finished.

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

-- Ambiguous characters (0/O, 1/I) are omitted -- these codes get read aloud
-- across a noisy table.
create or replace function public.bq_generate_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_try  int := 0;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms where code = v_code);
    v_try := v_try + 1;
    if v_try > 50 then
      raise exception 'could not allocate a room code';
    end if;
  end loop;
  return v_code;
end;
$$;

-- Resolves the calling user to their player row in a room. Raises if they are
-- not a member, which doubles as the authorisation check for most RPCs.
create or replace function public.bq_require_player(p_room_id uuid)
returns public.players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.players;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_player
  from public.players
  where room_id = p_room_id and user_id = auth.uid();

  if not found then
    raise exception 'you are not in this room';
  end if;

  return v_player;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_room / join_room
-- ---------------------------------------------------------------------------

create or replace function public.create_room(p_nickname text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   public.rooms;
  v_player public.players;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(trim(p_nickname), '') = '' then
    raise exception 'nickname is required';
  end if;

  insert into public.rooms (code, owner_id)
  values (public.bq_generate_code(), auth.uid())
  returning * into v_room;

  insert into public.players (room_id, user_id, nickname, is_owner)
  values (v_room.id, auth.uid(), trim(p_nickname), true)
  returning * into v_player;

  return json_build_object(
    'room_id',   v_room.id,
    'code',      v_room.code,
    'player_id', v_player.id,
    'is_owner',  true
  );
end;
$$;

create or replace function public.join_room(p_code text, p_nickname text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   public.rooms;
  v_player public.players;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(trim(p_nickname), '') = '' then
    raise exception 'nickname is required';
  end if;

  select * into v_room
  from public.rooms
  where code = upper(trim(p_code));

  if not found then
    raise exception 'no room with that code';
  end if;

  -- Rejoining your own room after a refresh or a phone lock must always work,
  -- even mid-game. Only *new* players are turned away once play has started.
  select * into v_player
  from public.players
  where room_id = v_room.id and user_id = auth.uid();

  if found then
    update public.players
      set nickname = trim(p_nickname), last_seen = now()
      where id = v_player.id
      returning * into v_player;
  else
    if v_room.status <> 'lobby' then
      raise exception 'this game has already started';
    end if;

    if exists (
      select 1 from public.players
      where room_id = v_room.id
        and lower(trim(nickname)) = lower(trim(p_nickname))
    ) then
      raise exception 'that nickname is already taken in this room';
    end if;

    insert into public.players (room_id, user_id, nickname, is_owner)
    values (v_room.id, auth.uid(), trim(p_nickname), false)
    returning * into v_player;
  end if;

  return json_build_object(
    'room_id',   v_room.id,
    'code',      v_room.code,
    'player_id', v_player.id,
    'is_owner',  v_player.is_owner
  );
end;
$$;

create or replace function public.leave_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.players;
  v_room   public.rooms;
begin
  v_player := public.bq_require_player(p_room_id);
  select * into v_room from public.rooms where id = p_room_id;

  -- Leaving mid-game would tear down matches that other people have already
  -- bet on, so it is only allowed from the lobby.
  if v_room.status <> 'lobby' then
    raise exception 'you cannot leave once the game has started';
  end if;

  if v_player.is_owner then
    delete from public.rooms where id = p_room_id;
  else
    delete from public.players where id = v_player.id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- start_game
-- ---------------------------------------------------------------------------

create or replace function public.start_game(p_room_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player     public.players;
  v_room       public.rooms;
  v_count      int;
  v_matches    int;
  v_qpm        int;
  v_pool_size  int;
  v_first      uuid;
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
  v_matches := v_count / 2;  -- integer division: an odd player out spectates every match

  -- Shuffle, then pair adjacent players. With an odd headcount the final
  -- player has no partner and simply bets on every match.
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

  -- Draw a global pool of distinct questions and deal them out. Consecutive
  -- ordinals modulo the pool size guarantee no repeat *within* a match; if the
  -- bank is smaller than the whole game needs, questions recycle across matches.
  select count(*) into v_pool_size
  from (
    select 1 from public.questions where language = 'en' limit v_matches * v_qpm
  ) t;

  if v_pool_size < v_qpm then
    raise exception 'the question bank is too small (need at least % questions)', v_qpm;
  end if;

  with pool as (
    select id, row_number() over () - 1 as rn
    from (
      select id from public.questions
      where language = 'en'
      order by random()
      limit v_matches * v_qpm
    ) q
  ),
  slots as (
    select m.id as match_id, m.match_index, gs.pos,
           (m.match_index * v_qpm + gs.pos) % v_pool_size as pick
    from public.matches m
    cross join generate_series(0, v_qpm - 1) gs(pos)
    where m.room_id = p_room_id
  )
  insert into public.match_questions (match_id, question_id, position)
  select s.match_id, p.id, s.pos
  from slots s
  join pool p on p.rn = s.pick;

  select id into v_first
  from public.matches
  where room_id = p_room_id and match_index = 0;

  update public.rooms
    set status = 'in_progress', current_match_id = v_first
    where id = p_room_id;

  return json_build_object('match_count', v_matches, 'current_match_id', v_first);
end;
$$;

-- ---------------------------------------------------------------------------
-- betting
-- ---------------------------------------------------------------------------

create or replace function public.place_bet(
  p_match_id         uuid,
  p_backed_player_id uuid,
  p_amount           int
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match  public.matches;
  v_room   public.rooms;
  v_player public.players;
  v_amount int;
begin
  select * into v_match from public.matches where id = p_match_id;
  if not found then
    raise exception 'no such match';
  end if;

  v_player := public.bq_require_player(v_match.room_id);
  select * into v_room from public.rooms where id = v_match.room_id;

  if v_match.status <> 'betting' then
    raise exception 'betting is closed for this round';
  end if;

  if v_player.id in (v_match.player1_id, v_match.player2_id) then
    raise exception 'you are playing this round -- you cannot bet on it';
  end if;

  if p_backed_player_id not in (v_match.player1_id, v_match.player2_id) then
    raise exception 'you must back one of the two players in this round';
  end if;

  v_amount := greatest(1, least(p_amount, v_room.max_bet));

  insert into public.bets (match_id, bettor_id, backed_player_id, amount)
  values (p_match_id, v_player.id, p_backed_player_id, v_amount)
  on conflict (match_id, bettor_id) do update
    set backed_player_id = excluded.backed_player_id,
        amount           = excluded.amount,
        updated_at       = now();

  return json_build_object('amount', v_amount, 'backed_player_id', p_backed_player_id);
end;
$$;

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

  select * into v_room from public.rooms where id = v_match.room_id;

  update public.matches
    set status = 'active', started_at = now(), current_position = 0
    where id = p_match_id;

  update public.match_questions
    set asked_at = now(),
        deadline = now() + make_interval(secs => v_room.question_seconds)
    where match_id = p_match_id and position = 0;

  return json_build_object('status', 'active');
end;
$$;

-- ---------------------------------------------------------------------------
-- playing a round
-- ---------------------------------------------------------------------------

-- Returns the live view of a match for whoever is asking. Deliberately never
-- includes correct_index for the question in play -- that is the whole point.
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
  select * into v_room from public.rooms where id = v_match.room_id;

  select count(*) into v_total from public.match_questions where match_id = p_match_id;

  if v_match.status <> 'active' then
    return json_build_object(
      'match_id', p_match_id,
      'status',   v_match.status,
      'total',    v_total
    );
  end if;

  select * into v_mq
  from public.match_questions
  where match_id = p_match_id and position = v_match.current_position;

  select * into v_q from public.questions where id = v_mq.question_id;

  -- The previous question is settled, so its answer can safely be revealed.
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
    'position',     v_mq.position,
    'total',        v_total,
    'prompt',       v_q.prompt,
    'options',      v_q.options,
    'category',     v_q.category,
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

  if v_mq.deadline is not null and now() > v_mq.deadline then
    raise exception 'time is up for this question';
  end if;

  if p_selected_index is null or p_selected_index not between 0 and 3 then
    raise exception 'pick one of the four options';
  end if;

  select correct_index into v_correct from public.questions where id = v_mq.question_id;
  v_is_ok := (v_correct = p_selected_index);

  -- First answer wins; a second submission for the same question is ignored.
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

  -- Deliberately does not say whether the answer was right: that is revealed
  -- once both duellists have committed and the question advances.
  return json_build_object('accepted', true);
end;
$$;

-- Settles a finished duel: scores, winner, drinks ledger, and handover to the
-- next match. Split out so advance_match stays readable.
create or replace function public.bq_settle_match(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match  public.matches;
  v_room   public.rooms;
  v_p1s int; v_p2s int; v_p1ms int; v_p2ms int;
  v_winner uuid := null;
  v_loser  uuid := null;
  v_draw   boolean := false;
  v_next   uuid;
begin
  select * into v_match from public.matches where id = p_match_id;
  select * into v_room  from public.rooms   where id = v_match.room_id;

  select
    count(*) filter (where a.player_id = v_match.player1_id and a.is_correct),
    count(*) filter (where a.player_id = v_match.player2_id and a.is_correct),
    coalesce(sum(a.ms_taken) filter (where a.player_id = v_match.player1_id), 0),
    coalesce(sum(a.ms_taken) filter (where a.player_id = v_match.player2_id), 0)
  into v_p1s, v_p2s, v_p1ms, v_p2ms
  from public.answers a
  join public.match_questions mq on mq.id = a.match_question_id
  where mq.match_id = p_match_id;

  -- More correct answers wins; a tie is broken by who was quicker overall.
  if v_p1s > v_p2s then
    v_winner := v_match.player1_id; v_loser := v_match.player2_id;
  elsif v_p2s > v_p1s then
    v_winner := v_match.player2_id; v_loser := v_match.player1_id;
  elsif v_p1ms < v_p2ms then
    v_winner := v_match.player1_id; v_loser := v_match.player2_id;
  elsif v_p2ms < v_p1ms then
    v_winner := v_match.player2_id; v_loser := v_match.player1_id;
  else
    v_draw := true;  -- dead heat: bets are void and nobody drinks
  end if;

  update public.matches
    set status = 'finished',
        finished_at = now(),
        p1_score = v_p1s, p2_score = v_p2s,
        p1_ms = v_p1ms,   p2_ms = v_p2ms,
        winner_id = v_winner,
        is_draw = v_draw
    where id = p_match_id;

  if not v_draw then
    -- The duellist who lost the quiz owes the fixed penalty.
    if v_room.penalty_mouthfuls > 0 then
      insert into public.drinks (room_id, match_id, player_id, mouthfuls, reason)
      values (v_match.room_id, p_match_id, v_loser, v_room.penalty_mouthfuls, 'quiz_loss')
      on conflict (match_id, player_id, reason) do nothing;
    end if;

    -- Everyone who backed the losing duellist drinks their own stake.
    insert into public.drinks (room_id, match_id, player_id, mouthfuls, reason)
    select v_match.room_id, p_match_id, b.bettor_id, b.amount, 'lost_bet'
    from public.bets b
    where b.match_id = p_match_id
      and b.backed_player_id <> v_winner
    on conflict (match_id, player_id, reason) do nothing;
  end if;

  -- Hand over to the next duel, or close the game out.
  select id into v_next
  from public.matches
  where room_id = v_match.room_id and match_index > v_match.match_index
  order by match_index
  limit 1;

  if v_next is not null then
    update public.matches set status = 'betting' where id = v_next;
    update public.rooms set current_match_id = v_next where id = v_match.room_id;
  else
    update public.rooms
      set status = 'finished', finished_at = now(), current_match_id = null
      where id = v_match.room_id;
  end if;
end;
$$;

-- Idempotent state pump. Any client in the room may call it; it only does
-- something when the current question is genuinely resolved (both answered, or
-- the deadline passed). This keeps the game moving even if a duellist's phone
-- goes to sleep.
create or replace function public.advance_match(p_match_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match    public.matches;
  v_room     public.rooms;
  v_mq       public.match_questions;
  v_answers  int;
  v_total    int;
  v_expired  boolean;
begin
  select * into v_match from public.matches where id = p_match_id for update;
  if not found then
    raise exception 'no such match';
  end if;

  perform public.bq_require_player(v_match.room_id);

  if v_match.status <> 'active' then
    return json_build_object('status', v_match.status);
  end if;

  select * into v_room from public.rooms where id = v_match.room_id;

  select * into v_mq
  from public.match_questions
  where match_id = p_match_id and position = v_match.current_position;

  select count(*) into v_answers
  from public.answers
  where match_question_id = v_mq.id
    and player_id in (v_match.player1_id, v_match.player2_id);

  v_expired := v_mq.deadline is not null and now() > v_mq.deadline;

  if v_answers < 2 and not v_expired then
    return json_build_object('status', 'active', 'position', v_match.current_position);
  end if;

  -- Record a miss for anyone who ran out of time, so scoring can just read
  -- the answers table without worrying about gaps.
  if v_answers < 2 then
    insert into public.answers
      (match_question_id, player_id, selected_index, is_correct, ms_taken)
    select v_mq.id, p, null, false,
           (extract(epoch from (v_mq.deadline - v_mq.asked_at)) * 1000)::int
    from unnest(array[v_match.player1_id, v_match.player2_id]) p
    on conflict (match_question_id, player_id) do nothing;
  end if;

  select count(*) into v_total from public.match_questions where match_id = p_match_id;

  if v_match.current_position + 1 < v_total then
    update public.matches
      set current_position = v_match.current_position + 1,
          p1_score = (select count(*) from public.answers a
                      join public.match_questions mq on mq.id = a.match_question_id
                      where mq.match_id = p_match_id
                        and a.player_id = v_match.player1_id and a.is_correct),
          p2_score = (select count(*) from public.answers a
                      join public.match_questions mq on mq.id = a.match_question_id
                      where mq.match_id = p_match_id
                        and a.player_id = v_match.player2_id and a.is_correct)
      where id = p_match_id;

    update public.match_questions
      set asked_at = now(),
          deadline = now() + make_interval(secs => v_room.question_seconds)
      where match_id = p_match_id and position = v_match.current_position + 1;

    return json_build_object('status', 'active', 'position', v_match.current_position + 1);
  end if;

  perform public.bq_settle_match(p_match_id);
  return json_build_object('status', 'finished');
end;
$$;

-- ---------------------------------------------------------------------------
-- results
-- ---------------------------------------------------------------------------

create or replace function public.get_match_results(p_match_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match public.matches;
begin
  select * into v_match from public.matches where id = p_match_id;
  if not found then
    raise exception 'no such match';
  end if;

  perform public.bq_require_player(v_match.room_id);

  if v_match.status <> 'finished' then
    raise exception 'this round is not finished yet';
  end if;

  return json_build_object(
    'match_id',  v_match.id,
    'p1',        (select json_build_object('id', id, 'nickname', nickname)
                  from public.players where id = v_match.player1_id),
    'p2',        (select json_build_object('id', id, 'nickname', nickname)
                  from public.players where id = v_match.player2_id),
    'p1_score',  v_match.p1_score,
    'p2_score',  v_match.p2_score,
    'p1_ms',     v_match.p1_ms,
    'p2_ms',     v_match.p2_ms,
    'winner_id', v_match.winner_id,
    'is_draw',   v_match.is_draw,
    'questions', coalesce((
      select json_agg(json_build_object(
               'position',      mq.position,
               'prompt',        q.prompt,
               'options',       q.options,
               'correct_index', q.correct_index,
               'p1_selected',   a1.selected_index,
               'p2_selected',   a2.selected_index
             ) order by mq.position)
      from public.match_questions mq
      join public.questions q on q.id = mq.question_id
      left join public.answers a1
        on a1.match_question_id = mq.id and a1.player_id = v_match.player1_id
      left join public.answers a2
        on a2.match_question_id = mq.id and a2.player_id = v_match.player2_id
      where mq.match_id = p_match_id
    ), '[]'::json),
    'bets', coalesce((
      select json_agg(json_build_object(
               'bettor',   pb.nickname,
               'backed',   pk.nickname,
               'amount',   b.amount,
               'won',      (not v_match.is_draw and b.backed_player_id = v_match.winner_id)
             ))
      from public.bets b
      join public.players pb on pb.id = b.bettor_id
      join public.players pk on pk.id = b.backed_player_id
      where b.match_id = p_match_id
    ), '[]'::json),
    'drinks', coalesce((
      select json_agg(json_build_object(
               'player',    p.nickname,
               'mouthfuls', d.mouthfuls,
               'reason',    d.reason
             ))
      from public.drinks d
      join public.players p on p.id = d.player_id
      where d.match_id = p_match_id
    ), '[]'::json)
  );
end;
$$;

create or replace function public.get_leaderboard(p_room_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.bq_require_player(p_room_id);

  return coalesce((
    select json_agg(row_to_json(t) order by t.mouthfuls, t.wins desc, t.nickname)
    from (
      select
        p.id,
        p.nickname,
        coalesce((select sum(d.mouthfuls) from public.drinks d
                  where d.player_id = p.id), 0)::int as mouthfuls,
        (select count(*) from public.matches m
         where m.winner_id = p.id)::int as wins,
        (select count(*) from public.matches m
         where m.room_id = p_room_id and m.status = 'finished'
           and p.id in (m.player1_id, m.player2_id)
           and not m.is_draw and m.winner_id <> p.id)::int as losses,
        (select count(*) from public.bets b
         join public.matches m on m.id = b.match_id
         where b.bettor_id = p.id and m.status = 'finished'
           and not m.is_draw and b.backed_player_id = m.winner_id)::int as bets_won,
        (select count(*) from public.bets b
         join public.matches m on m.id = b.match_id
         where b.bettor_id = p.id and m.status = 'finished'
           and not m.is_draw and b.backed_player_id <> m.winner_id)::int as bets_lost
      from public.players p
      where p.room_id = p_room_id
    ) t
  ), '[]'::json);
end;
$$;
