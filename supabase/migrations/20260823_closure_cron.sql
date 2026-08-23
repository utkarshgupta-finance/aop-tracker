-- Capture closures 5 minutes BEFORE each sync-ar run (:30), while the rows
-- sync-ar is about to delete are still present in ar_invoices.
-- NOTE: the Authorization header carries the public anon key (same pattern as
-- the existing sync-ar-balances-nightly job). Replace <ANON_KEY> when applying
-- this by hand.
select cron.schedule('capture-closures-before-sync', '25 2,4,6,8,10,12,14,16,18 * * *', $job$
  select net.http_post(
    url     := 'https://vntqszeaokcbrzuppmew.supabase.co/functions/v1/capture-closures',
    body    := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <ANON_KEY>"}'::jsonb
  )
$job$);

-- Safety net: rebuild from snapshot gaps if a capture run is ever missed.
-- Runs after the nightly snapshot (taken at 18:20).
select cron.schedule('recover-closures-nightly', '0 19 * * *', $job$
  select recover_closures_from_snapshots()
$job$);
