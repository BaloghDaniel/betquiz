-- Delete idle rooms and stray anonymous users on a schedule.
--
-- Activity is tracked in its own table rather than as a column on `rooms`.
-- `rooms` is in the supabase_realtime publication, so writing a heartbeat there
-- would broadcast an UPDATE to every device in the room on every beat, and
-- useRoom refetches the whole room on any change -- a refetch storm purely to
-- record "someone is still here". room_activity is deliberately NOT published.
--
-- The heartbeat is necessary, not incidental: players.last_seen is only written
-- on join, so without it a room in the middle of a duel looks idle and would be
-- deleted out from under the people playing it.

create table if not exists public.room_activity (
  room_id          uuid primary key references public.rooms (id) on delete cascade,
  last_activity_at timestamptz not null default now()
);

alter table public.room_activity enable row level security;
revoke all on public.room_activity from anon, authenticated;
-- No policies, no grants: written only via touch_room, read only by cleanup.

-- Speeds up the "is this user in any room?" test the user sweep depends on.
create index if not exists players_user_id_idx on public.players (user_id);

-- --------------------------------------------------------------------------
-- Heartbeat. Any member of a room can say "this room is still open".
-- --------------------------------------------------------------------------
create or replace function public.touch_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.bq_require_player(p_room_id);

  insert into public.room_activity (room_id, last_activity_at)
  values (p_room_id, now())
  on conflict (room_id) do update set last_activity_at = now();
end;
$$;

revoke execute on function public.touch_room(uuid) from public, anon;
grant  execute on function public.touch_room(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- The sweep.
-- --------------------------------------------------------------------------
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

  -- Anonymous users who are in no room at all. Deleting a room above cascades
  -- its players away, so its members become eligible on this same pass.
  --
  -- The "in no room" test is the real safety property here, not the age: a user
  -- who owns or plays in a live room always has a players row and can never be
  -- selected. The age check only avoids catching someone who signed in seconds
  -- ago and has not typed a room code yet.
  --
  -- Note auth.users cascades to rooms via rooms_owner_id_fkey, which is exactly
  -- why the players-row test has to come first.
  with gone as (
    delete from auth.users u
    where u.is_anonymous = true
      and u.created_at < now() - p_user_idle
      and not exists (select 1 from public.players p where p.user_id = u.id)
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

-- Maintenance only. Never callable from the app.
revoke execute on function public.bq_cleanup(interval, interval) from public, anon, authenticated;
