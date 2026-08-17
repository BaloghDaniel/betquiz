-- Let the host remove a player from the lobby.
--
-- Needed because a player row deliberately survives the browser closing --
-- that is what makes "Rejoin" work after a phone lock or an accidental tab
-- close. The cost is that someone who leaves for good still occupies a slot
-- and would get paired into a duel they are not present for, so the host needs
-- a way to clear them out.
--
-- Lobby only. Removing a player mid-game would orphan matches they are a
-- duellist in and bets they placed or that were placed on them; that is a
-- much bigger change than this, and the host can already close the room.

create or replace function public.remove_player(p_room_id uuid, p_player_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller public.players;
  v_room   public.rooms;
  v_target public.players;
begin
  v_caller := public.bq_require_player(p_room_id);
  if not v_caller.is_owner then
    raise exception 'only the room owner can remove players';
  end if;

  select * into v_room from public.rooms where id = p_room_id;
  if v_room.status <> 'lobby' then
    raise exception 'you can only remove players before the game starts';
  end if;

  select * into v_target
  from public.players
  where id = p_player_id and room_id = p_room_id;

  if not found then
    raise exception 'that player is not in this room';
  end if;

  -- The host removing themselves would leave the room ownerless and unstartable.
  if v_target.id = v_caller.id then
    raise exception 'you cannot remove yourself -- close the room instead';
  end if;

  delete from public.players where id = p_player_id;

  return json_build_object('removed_player_id', p_player_id, 'nickname', v_target.nickname);
end;
$$;

revoke execute on function public.remove_player(uuid, uuid) from public, anon;
grant  execute on function public.remove_player(uuid, uuid) to authenticated;
