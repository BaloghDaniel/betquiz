-- Give the round result a moment to breathe.
--
-- Originally bq_settle_match promoted the next duel to 'betting' the instant it
-- settled, which meant the room jumped straight to the next betting screen and
-- nobody ever saw who owed what. Settling now stops at 'finished' and the owner
-- presses on when the table has finished drinking.

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

  if v_p1s > v_p2s then
    v_winner := v_match.player1_id; v_loser := v_match.player2_id;
  elsif v_p2s > v_p1s then
    v_winner := v_match.player2_id; v_loser := v_match.player1_id;
  elsif v_p1ms < v_p2ms then
    v_winner := v_match.player1_id; v_loser := v_match.player2_id;
  elsif v_p2ms < v_p1ms then
    v_winner := v_match.player2_id; v_loser := v_match.player1_id;
  else
    v_draw := true;
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
    if v_room.penalty_mouthfuls > 0 then
      insert into public.drinks (room_id, match_id, player_id, mouthfuls, reason)
      values (v_match.room_id, p_match_id, v_loser, v_room.penalty_mouthfuls, 'quiz_loss')
      on conflict (match_id, player_id, reason) do nothing;
    end if;

    insert into public.drinks (room_id, match_id, player_id, mouthfuls, reason)
    select v_match.room_id, p_match_id, b.bettor_id, b.amount, 'lost_bet'
    from public.bets b
    where b.match_id = p_match_id
      and b.backed_player_id <> v_winner
    on conflict (match_id, player_id, reason) do nothing;
  end if;
end;
$$;

-- Owner-driven handover from a finished round to the next one, or to the final
-- leaderboard when there are no duels left.
create or replace function public.next_round(p_room_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player  public.players;
  v_room    public.rooms;
  v_current public.matches;
  v_next    uuid;
begin
  v_player := public.bq_require_player(p_room_id);
  if not v_player.is_owner then
    raise exception 'only the room owner can move to the next round';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;

  if v_room.status = 'finished' then
    return json_build_object('status', 'finished');  -- idempotent
  end if;

  if v_room.status <> 'in_progress' then
    raise exception 'the game is not in progress';
  end if;

  select * into v_current from public.matches where id = v_room.current_match_id;
  if v_current.status <> 'finished' then
    raise exception 'this round is not finished yet';
  end if;

  select id into v_next
  from public.matches
  where room_id = p_room_id and match_index > v_current.match_index
  order by match_index
  limit 1;

  if v_next is not null then
    update public.matches set status = 'betting' where id = v_next;
    update public.rooms set current_match_id = v_next where id = p_room_id;
    return json_build_object('status', 'betting', 'match_id', v_next);
  end if;

  update public.rooms
    set status = 'finished', finished_at = now()
    where id = p_room_id;

  return json_build_object('status', 'finished');
end;
$$;

revoke execute on function public.next_round(uuid) from public, anon;
grant  execute on function public.next_round(uuid) to authenticated;
