-- Enable pg_net for outbound HTTP calls from cron jobs
create extension if not exists pg_net with schema extensions;

-- Schedule Zoho AR sync every 2 hours from 8am to midnight IST
-- IST = UTC+5:30, so 08:00–00:00 IST = 02:30–18:30 UTC
select cron.schedule(
  'sync-ar-every-2h',
  '30 2,4,6,8,10,12,14,16,18 * * *',
  $$
  select extensions.http_post(
    url    := 'https://vntqszeaokcbrzuppmew.supabase.co/functions/v1/sync-ar?cron=1',
    body   := '{}',
    params := array[('Content-Type','application/json')]
  )
  $$
);
