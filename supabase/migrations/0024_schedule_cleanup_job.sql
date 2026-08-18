create extension if not exists pg_cron;

-- Idempotent: unschedule any previous definition before (re)creating it, so
-- re-running this migration cannot leave two jobs racing each other.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'betquiz-cleanup') then
    perform cron.unschedule('betquiz-cleanup');
  end if;
end $$;

-- Every 5 minutes. The window is 10 minutes, so a room is deleted between 10
-- and 15 minutes after it goes quiet -- close enough, and far cheaper than
-- running every minute.
select cron.schedule(
  'betquiz-cleanup',
  '*/5 * * * *',
  $$select public.bq_cleanup()$$
);
