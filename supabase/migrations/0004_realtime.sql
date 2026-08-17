-- Publish the live-state tables so every phone in the room updates without polling.
--
-- Realtime only delivers rows the subscriber is allowed to SELECT, so the
-- policies in 0003_rls.sql do double duty here. questions, match_questions and
-- answers are deliberately NOT published -- an answer row streaming to a
-- spectator's device would leak whether a duellist just got it right.

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.matches;
alter publication supabase_realtime add table public.bets;
alter publication supabase_realtime add table public.drinks;

-- Realtime sends only the primary key on UPDATE/DELETE unless the table has a
-- full replica identity. The client needs the whole row to update the UI.
alter table public.rooms    replica identity full;
alter table public.players  replica identity full;
alter table public.matches  replica identity full;
alter table public.bets     replica identity full;
alter table public.drinks   replica identity full;
