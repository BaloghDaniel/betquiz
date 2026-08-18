-- Actually make the dev-room helpers internal, as 0021 said they were.
--
-- 0021 ends with the comment "bq_dev_reset and bq_bot_answers stay internal:
-- they are only ever reached from join_room and advance_match, which run as the
-- definer" -- but it never revoked them, so they were callable by `authenticated`
-- the whole time.
--
-- The trap: `0003_rls.sql` does `revoke execute on all functions in schema
-- public from public, anon, authenticated`, which reads like a standing rule but
-- is a point-in-time snapshot. Postgres grants EXECUTE to PUBLIC by default on
-- every *newly created* function, so anything added after 0003 is client-callable
-- unless it revokes explicitly. Every function added in 0009/0019/0020/0023 did
-- revoke or was meant to be public; these two were the gap.
--
-- Exposure was low -- bq_bot_answers is a no-op in any room without bots, and
-- bq_dev_reset only resets the 111111 sandbox -- but the schema's whole premise
-- is that the client reaches nothing except through vetted RPCs.

revoke execute on function public.bq_dev_reset(text) from public, anon, authenticated;
revoke execute on function public.bq_bot_answers(uuid) from public, anon, authenticated;
