-- Scope the leaderboard subqueries to the room, and index what they read.
--
-- The counts were already correct -- a player row belongs to exactly one room,
-- so winner_id / player_id could only ever match rows from this room -- but they
-- scanned every match and drink ever recorded to prove it. Filtering by room
-- makes the intent explicit and keeps the query flat as rooms accumulate.

create index if not exists matches_winner_idx on public.matches (winner_id);
create index if not exists drinks_player_idx  on public.drinks (player_id);
create index if not exists answers_player_idx on public.answers (player_id);
create index if not exists bets_bettor_idx    on public.bets (bettor_id);

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
                  where d.player_id = p.id and d.room_id = p_room_id), 0)::int as mouthfuls,
        (select count(*) from public.matches m
         where m.room_id = p_room_id and m.winner_id = p.id)::int as wins,
        (select count(*) from public.matches m
         where m.room_id = p_room_id and m.status = 'finished'
           and p.id in (m.player1_id, m.player2_id)
           and not m.is_draw and m.winner_id <> p.id)::int as losses,
        (select count(*) from public.bets b
         join public.matches m on m.id = b.match_id
         where b.bettor_id = p.id and m.room_id = p_room_id and m.status = 'finished'
           and not m.is_draw and b.backed_player_id = m.winner_id)::int as bets_won,
        (select count(*) from public.bets b
         join public.matches m on m.id = b.match_id
         where b.bettor_id = p.id and m.room_id = p_room_id and m.status = 'finished'
           and not m.is_draw and b.backed_player_id <> m.winner_id)::int as bets_lost
      from public.players p
      where p.room_id = p_room_id
    ) t
  ), '[]'::json);
end;
$$;
