-- A one-player sandbox for exercising the whole chain without a room full of
-- friends. Join the code 111111 and you get a fresh room containing you and two
-- bots, then pick per round whether you duel or bet.
--
-- Three players is exactly the right number: floor(3/2) = one duel plus one
-- spectator, so "I play" pairs you with a bot and leaves the other to bet, and
-- "I bet" pairs the two bots and leaves you betting. Both paths through the
-- game get covered by flipping one choice.
--
-- Bots have no auth identity at all (`user_id` is null). They never call an
-- RPC; the server acts for them from inside advance_match and dev_start_round.
-- That keeps them out of RLS entirely -- bq_is_member matches on
-- user_id = auth.uid(), which a null can never satisfy.

alter table public.players
  add column if not exists is_bot boolean not null default false,
  add column if not exists bot_skill int not null default 60
    check (bot_skill between 0 and 100);

alter table public.players alter column user_id drop not null;

-- A bot row has no user; a human row must have one.
alter table public.players
  drop constraint if exists players_user_or_bot;
alter table public.players
  add constraint players_user_or_bot
  check ((is_bot and user_id is null) or (not is_bot and user_id is not null));

alter table public.rooms
  add column if not exists is_dev boolean not null default false;

-- --------------------------------------------------------------------------
-- Reset the sandbox and seat the caller in it.
-- --------------------------------------------------------------------------
create or replace function public.bq_dev_reset(p_nickname text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room_id uuid;
begin
  select id into v_room_id from public.rooms where code = '111111';

  if v_room_id is null then
    insert into public.rooms (code, owner_id, is_dev, status)
    values ('111111', auth.uid(), true, 'lobby')
    returning id into v_room_id;
  else
    -- Wipe the previous session. Matches cascade to match_themes,
    -- match_questions, answers and bets; drinks are keyed to the room.
    delete from public.matches where room_id = v_room_id;
    delete from public.drinks  where room_id = v_room_id;
    delete from public.players where room_id = v_room_id;

    update public.rooms
      set owner_id = auth.uid(),
          status = 'lobby',
          current_match_id = null,
          finished_at = null,
          is_dev = true
      where id = v_room_id;
  end if;

  insert into public.players (room_id, user_id, nickname, is_owner)
  values (v_room_id, auth.uid(), trim(p_nickname), true);

  insert into public.players (room_id, user_id, nickname, is_owner, is_bot, bot_skill)
  values (v_room_id, null, 'Botsy',  false, true, 70),
         (v_room_id, null, 'Roboto', false, true, 45);

  return v_room_id;
end;
$$;

-- --------------------------------------------------------------------------
-- join_room: the code 111111 hands back a fresh sandbox instead of a lobby.
-- --------------------------------------------------------------------------
create or replace function public.join_room(p_code text, p_nickname text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   public.rooms;
  v_player public.players;
  v_code   text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(trim(p_nickname), '') = '' then
    raise exception 'nickname is required';
  end if;

  v_code := upper(trim(p_code));

  -- The sandbox resets on every join, so it is always ready to replay the
  -- whole chain from scratch. Two people using it at once would clobber each
  -- other; it is a development tool, not a room.
  if v_code = '111111' then
    return json_build_object(
      'room_id',   public.bq_dev_reset(p_nickname),
      'code',      '111111',
      'player_id', (select id from public.players
                    where room_id = (select id from public.rooms where code = '111111')
                      and user_id = auth.uid()),
      'is_owner',  true
    );
  end if;

  select * into v_room from public.rooms where code = v_code;

  if not found then
    raise exception 'no room with that code';
  end if;

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

-- --------------------------------------------------------------------------
-- Bots answering. Called from advance_match, so it runs on the same poll that
-- already drives the game forward.
-- --------------------------------------------------------------------------
create or replace function public.bq_bot_answers(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match public.matches;
  v_mq    public.match_questions;
  v_bot   record;
  v_seed  bigint;
  v_roll  int;
  v_pick  int;
  v_correct int;
begin
  select * into v_match from public.matches where id = p_match_id;
  if v_match.status <> 'active' then
    return;
  end if;

  select * into v_mq
  from public.match_questions
  where match_id = p_match_id and position = v_match.current_position;

  -- Nothing to do before the question has actually started (the theme reveal
  -- is still on screen) or after it has expired.
  if v_mq.asked_at is null or now() < v_mq.asked_at then
    return;
  end if;

  select correct_index into v_correct from public.questions where id = v_mq.question_id;

  for v_bot in
    select p.id, p.bot_skill
    from public.players p
    where p.is_bot
      and p.id in (v_match.player1_id, v_match.player2_id)
      and not exists (
        select 1 from public.answers a
        where a.match_question_id = v_mq.id and a.player_id = p.id
      )
  loop
    -- Deterministic per (question, bot): the same bot always makes the same
    -- decision about the same question, so repeated polls cannot make it
    -- "reroll" its way to a different answer or a shifting delay.
    v_seed := abs(hashtext(v_mq.id::text || v_bot.id::text));
    v_roll := (v_seed % 100)::int;

    -- Think for 2-5 seconds so a bot-vs-bot duel is watchable rather than
    -- resolving the instant the question opens.
    if now() < v_mq.asked_at + make_interval(secs => 2 + (v_seed % 4)) then
      continue;
    end if;

    if v_roll < v_bot.bot_skill then
      v_pick := v_correct;
    else
      v_pick := (v_correct + 1 + (v_roll % 3)) % 4;
    end if;

    insert into public.answers
      (match_question_id, player_id, selected_index, is_correct, ms_taken)
    values (
      v_mq.id, v_bot.id, v_pick, v_pick = v_correct,
      greatest(0, extract(epoch from (now() - v_mq.asked_at)) * 1000)::int
    )
    on conflict (match_question_id, player_id) do nothing;
  end loop;
end;
$$;

-- --------------------------------------------------------------------------
-- advance_match: let the bots answer before deciding whether to move on.
-- --------------------------------------------------------------------------
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

  perform public.bq_bot_answers(p_match_id);

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

-- --------------------------------------------------------------------------
-- dev_start_round: build the next duel with the pairing the developer picked.
-- --------------------------------------------------------------------------
create or replace function public.dev_start_round(p_room_id uuid, p_mode text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.players;
  v_room   public.rooms;
  v_bots   uuid[];
  v_p1     uuid;
  v_p2     uuid;
  v_index  int;
  v_match  uuid;
  v_qpm    int;
begin
  v_caller := public.bq_require_player(p_room_id);

  select * into v_room from public.rooms where id = p_room_id for update;
  if not v_room.is_dev then
    raise exception 'this is not the sandbox room';
  end if;
  if not v_caller.is_owner then
    raise exception 'only the room owner can start a round';
  end if;
  if p_mode not in ('play', 'bet') then
    raise exception 'mode must be play or bet';
  end if;

  -- A round cannot start on top of one still in progress.
  if exists (
    select 1 from public.matches
    where room_id = p_room_id and status in ('betting', 'active')
  ) then
    raise exception 'a round is already in progress';
  end if;

  select array_agg(id order by nickname) into v_bots
  from public.players where room_id = p_room_id and is_bot;

  if coalesce(array_length(v_bots, 1), 0) < 2 then
    raise exception 'the sandbox needs two bots -- rejoin with code 111111 to reset';
  end if;

  if p_mode = 'play' then
    v_p1 := v_caller.id;  v_p2 := v_bots[1];   -- you duel, the spare bot bets
  else
    v_p1 := v_bots[1];    v_p2 := v_bots[2];   -- bots duel, you bet
  end if;

  select coalesce(max(match_index) + 1, 0) into v_index
  from public.matches where room_id = p_room_id;

  insert into public.matches (room_id, match_index, player1_id, player2_id, status)
  values (p_room_id, v_index, v_p1, v_p2, 'betting')
  returning id into v_match;

  v_qpm := v_room.questions_per_match;

  insert into public.match_themes (match_id, category_a, category_b)
  select v_match,
         max(case when rn = 1 then category end),
         coalesce(max(case when rn = 2 then category end),
                  max(case when rn = 1 then category end))
  from (
    select category, row_number() over (order by random()) as rn
    from public.questions
    where language = 'en'
    group by category
    having count(*) >= v_qpm
  ) c
  where rn <= 2;

  -- Any bot not duelling backs someone, so the betting screen has something on
  -- it and the payout path gets exercised.
  insert into public.bets (match_id, bettor_id, backed_player_id, amount)
  select v_match, p.id,
         case when random() < 0.5 then v_p1 else v_p2 end,
         1 + floor(random() * v_room.max_bet)::int
  from public.players p
  where p.room_id = p_room_id and p.is_bot and p.id not in (v_p1, v_p2)
  on conflict (match_id, bettor_id) do nothing;

  update public.rooms
    set status = 'in_progress', current_match_id = v_match, finished_at = null
    where id = p_room_id;

  return json_build_object('match_id', v_match, 'mode', p_mode, 'match_index', v_index);
end;
$$;

revoke execute on function public.dev_start_round(uuid, text) from public, anon;
grant  execute on function public.dev_start_round(uuid, text) to authenticated;
-- bq_dev_reset and bq_bot_answers stay internal: they are only ever reached
-- from join_room and advance_match, which run as the definer.
