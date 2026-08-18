-- Spread bot think-time smoothly across 2-5 seconds.
--
-- The previous version used `2 + (seed % 4)`, which only ever produced 2, 3, 4
-- or 5 exactly -- with two bots that lands them on the same whole second
-- surprisingly often and reads as mechanical. This uses the full millisecond
-- range instead.
--
-- Still deterministic per (question, bot), and that is not optional:
-- advance_match is polled roughly every 700ms by every client, so a bot drawing
-- fresh randomness on each call would keep changing both its answer and its
-- deadline and might never commit to either.
--
-- Note this function only runs when advance_match runs. The client must keep
-- calling advance_match while a bot still owes an answer -- see the comment in
-- src/components/Quiz.tsx. Waiting for "both answered or expired" deadlocks:
-- the bot cannot answer until advance_match is called, and it would not be
-- called until the bot answered, so every question ran its full timer.

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
  v_wait  numeric;
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
  -- is still on screen).
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
    v_seed := abs(hashtext(v_mq.id::text || v_bot.id::text));
    v_roll := (v_seed % 100)::int;

    -- 2.000s .. 4.999s, evenly spread rather than four fixed points.
    v_wait := 2 + ((v_seed / 100) % 3000)::numeric / 1000;

    if now() < v_mq.asked_at + make_interval(secs => v_wait) then
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
