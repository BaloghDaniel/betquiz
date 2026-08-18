-- Never delete a user who owns a room, even if they hold no players row.
--
-- Found while testing 0023: `rooms.owner_id` references auth.users ON DELETE
-- CASCADE, so removing a user silently takes their rooms with them. The user
-- sweep only skipped users with a `players` row, which today is equivalent --
-- create_room and bq_dev_reset both seat the owner as a player -- but nothing
-- in the schema enforces that. Any future path that creates a room without
-- seating its owner would make the cleanup job start eating live rooms, and the
-- symptom would be rooms vanishing for no visible reason.
--
-- Checking ownership directly removes the dependency on that coincidence.

create or replace function public.bq_cleanup(
  p_room_idle interval default '10 minutes',
  p_user_idle interval default '30 minutes'
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rooms int;
  v_users int;
begin
  -- Rooms with nobody watching. A room that has never been touched falls back
  -- to its creation time, so an abandoned empty room still expires.
  with stale as (
    delete from public.rooms r
    where coalesce(
            (select a.last_activity_at from public.room_activity a where a.room_id = r.id),
            r.created_at
          ) < now() - p_room_idle
    returning 1
  )
  select count(*) into v_rooms from stale;

  -- Anonymous users attached to no room at all. Deleting a room above cascades
  -- its players away, so its members become eligible on this same pass.
  --
  -- Both attachment tests matter, and neither is about age: playing in a room
  -- (players) and owning one (rooms.owner_id) each make a user off-limits. The
  -- age check only avoids catching someone who signed in seconds ago and has
  -- not typed a room code yet.
  with gone as (
    delete from auth.users u
    where u.is_anonymous = true
      and u.created_at < now() - p_user_idle
      and not exists (select 1 from public.players p where p.user_id = u.id)
      and not exists (select 1 from public.rooms   r where r.owner_id = u.id)
    returning 1
  )
  select count(*) into v_users from gone;

  return json_build_object(
    'rooms_deleted', v_rooms,
    'users_deleted', v_users,
    'ran_at', now()
  );
end;
$$;

revoke execute on function public.bq_cleanup(interval, interval) from public, anon, authenticated;

create index if not exists rooms_owner_id_idx on public.rooms (owner_id);
