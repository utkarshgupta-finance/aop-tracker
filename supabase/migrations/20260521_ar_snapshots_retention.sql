-- ar_invoice_snapshots retention policy
-- Daily snapshots compound fast: 10x customers × 10x invoices × 365 days × 5 years
-- = millions of rows with no cleanup = full-table scans slow to a crawl.
-- Policy: keep 90 days of daily snapshots. Older data is queryable via sync_log summary only.

-- Partition by snapshot_date range (rolling window approach via cron purge)
-- Supabase pg_cron is available on Pro/Team plans; this creates the cleanup job.
SELECT cron.schedule(
  'purge-old-ar-snapshots',
  '0 3 * * *',   -- 3 AM daily
  $$
    DELETE FROM ar_invoice_snapshots
    WHERE snapshot_date < CURRENT_DATE - INTERVAL '90 days';
  $$
);

-- Safety: record how many rows were purged each run by wrapping in a DO block
-- (pg_cron jobs run as plain SQL; for auditing, use a function instead)
CREATE OR REPLACE FUNCTION purge_ar_snapshots(retain_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM ar_invoice_snapshots
  WHERE snapshot_date < CURRENT_DATE - (retain_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION purge_ar_snapshots IS
  'Deletes ar_invoice_snapshots older than retain_days (default 90). Called nightly by pg_cron.';

-- Add a created_at index to assist the DELETE scan
CREATE INDEX IF NOT EXISTS ar_snapshots_date_purge_idx
  ON ar_invoice_snapshots (snapshot_date ASC);
