-- BetQuiz core schema.
--
-- Design note: clients get no direct write access to any of these tables. Every
-- mutation goes through a SECURITY DEFINER RPC (see 0002_rpcs.sql) so that scores,
-- winners and the drinks ledger are authoritative and cannot be forged by a player
-- holding the public anon key.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------
create table public.rooms (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  owner_id            uuid not null references auth.users (id) on delete cascade,
  status              text not null default 'lobby'
                        check (status in ('lobby', 'in_progress', 'finished')),
  current_match_id    uuid,
  questions_per_match int  not null default 10 check (questions_per_match between 1 and 20),
  penalty_mouthfuls   int  not null default 3  check (penalty_mouthfuls between 0 and 20),
  max_bet             int  not null default 5  check (max_bet between 1 and 20),
  question_seconds    int  not null default 20 check (question_seconds between 5 and 120),
  created_at          timestamptz not null default now(),
  finished_at         timestamptz
);

create index rooms_code_idx on public.rooms (code);

-- ---------------------------------------------------------------------------
-- players (room membership)
-- ---------------------------------------------------------------------------
create table public.players (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  nickname   text not null check (length(trim(nickname)) between 1 and 20),
  is_owner   boolean not null default false,
  joined_at  timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  unique (room_id, user_id)
);

-- Two people at the same table picking the same nickname is pure confusion.
create unique index players_room_nickname_idx
  on public.players (room_id, lower(trim(nickname)));

create index players_room_idx on public.players (room_id);

-- ---------------------------------------------------------------------------
-- matches (one 1v1 duel = one "round")
-- ---------------------------------------------------------------------------
create table public.matches (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms (id) on delete cascade,
  match_index  int  not null,
  player1_id   uuid not null references public.players (id) on delete cascade,
  player2_id   uuid not null references public.players (id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending', 'betting', 'active', 'finished')),
  winner_id    uuid references public.players (id) on delete set null,
  is_draw      boolean not null default false,
  p1_score     int not null default 0,
  p2_score     int not null default 0,
  p1_ms        int not null default 0,
  p2_ms        int not null default 0,
  current_position int not null default 0,
  started_at   timestamptz,
  finished_at  timestamptz,
  unique (room_id, match_index),
  check (player1_id <> player2_id)
);

create index matches_room_idx on public.matches (room_id, match_index);

alter table public.rooms
  add constraint rooms_current_match_fk
  foreign key (current_match_id) references public.matches (id) on delete set null;

-- ---------------------------------------------------------------------------
-- questions (never client-readable -- see 0003_rls.sql)
-- ---------------------------------------------------------------------------
create table public.questions (
  id            uuid primary key default gen_random_uuid(),
  prompt        text not null,
  options       text[] not null check (array_length(options, 1) = 4),
  correct_index int not null check (correct_index between 0 and 3),
  category      text not null default 'general',
  difficulty    text not null default 'medium'
                  check (difficulty in ('easy', 'medium', 'hard')),
  language      text not null default 'en',
  created_at    timestamptz not null default now()
);

create index questions_language_idx on public.questions (language);

-- ---------------------------------------------------------------------------
-- match_questions (the drawn deck for one duel)
-- ---------------------------------------------------------------------------
create table public.match_questions (
  id          uuid primary key default gen_random_uuid(),
  match_id    uuid not null references public.matches (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete restrict,
  position    int  not null,
  asked_at    timestamptz,
  deadline    timestamptz,
  unique (match_id, position),
  unique (match_id, question_id)
);

create index match_questions_match_idx on public.match_questions (match_id, position);

-- ---------------------------------------------------------------------------
-- answers
-- ---------------------------------------------------------------------------
create table public.answers (
  id                uuid primary key default gen_random_uuid(),
  match_question_id uuid not null references public.match_questions (id) on delete cascade,
  player_id         uuid not null references public.players (id) on delete cascade,
  selected_index    int  check (selected_index between 0 and 3), -- null = timed out
  is_correct        boolean not null default false,
  ms_taken          int not null default 0,
  answered_at       timestamptz not null default now(),
  unique (match_question_id, player_id)
);

-- ---------------------------------------------------------------------------
-- bets
-- ---------------------------------------------------------------------------
create table public.bets (
  id               uuid primary key default gen_random_uuid(),
  match_id         uuid not null references public.matches (id) on delete cascade,
  bettor_id        uuid not null references public.players (id) on delete cascade,
  backed_player_id uuid not null references public.players (id) on delete cascade,
  amount           int not null check (amount > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (match_id, bettor_id)
);

create index bets_match_idx on public.bets (match_id);

-- ---------------------------------------------------------------------------
-- drinks (the payout ledger -- the thing everyone actually cares about)
-- ---------------------------------------------------------------------------
create table public.drinks (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms (id) on delete cascade,
  match_id   uuid not null references public.matches (id) on delete cascade,
  player_id  uuid not null references public.players (id) on delete cascade,
  mouthfuls  int not null check (mouthfuls > 0),
  reason     text not null check (reason in ('lost_bet', 'quiz_loss')),
  created_at timestamptz not null default now(),
  -- A player owes at most one drink per reason per match; makes settlement idempotent.
  unique (match_id, player_id, reason)
);

create index drinks_room_idx on public.drinks (room_id);
create index drinks_match_idx on public.drinks (match_id);
