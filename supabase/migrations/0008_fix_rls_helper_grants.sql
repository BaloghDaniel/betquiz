-- Let clients actually execute the RLS helper functions.
--
-- 0003 revoked EXECUTE on every function in the schema and then re-granted only
-- the game RPCs, which quietly broke all reads: an RLS policy expression is
-- evaluated with the *caller's* privileges, so `using (bq_is_member(...))`
-- needs the caller to hold EXECUTE on bq_is_member. Being SECURITY DEFINER only
-- changes who the body runs as once it is already running -- it does not waive
-- the permission check to get in the door.
--
-- Safe to expose: both take an id the caller already has and return a boolean
-- about the caller's own membership. Neither leaks anything else, and neither
-- mutates. The genuinely dangerous internals (bq_settle_match, which could end
-- a duel early, plus bq_require_player and bq_generate_code) stay revoked --
-- they are only ever called from inside other SECURITY DEFINER functions, where
-- the definer's own privileges apply.

grant execute on function public.bq_is_member(uuid)          to authenticated;
grant execute on function public.bq_is_member_of_match(uuid) to authenticated;
