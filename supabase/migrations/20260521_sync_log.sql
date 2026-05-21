-- Operational observability: sync_log and sync_exceptions tables

-- sync_log: one row per import/sync run, regardless of outcome
CREATE TABLE IF NOT EXISTS sync_log (
  id            serial PRIMARY KEY,
  job_name      text        NOT NULL,       -- 'excel_module_data', 'zoho_ar', 'customer_master' etc.
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text        NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
  rows_examined integer,
  rows_inserted integer,
  rows_updated  integer,
  rows_skipped  integer,
  error_message text,
  run_by        text,                       -- email or 'cron'
  source_file   text                        -- filename/path of import source if applicable
);

CREATE INDEX IF NOT EXISTS idx_sync_log_job       ON sync_log (job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_log_status    ON sync_log (status) WHERE status IN ('failed','partial');

COMMENT ON TABLE sync_log IS 'Audit trail for every data import or sync job. Never delete rows.';

-- sync_exceptions: rows that could not be processed during a sync run
CREATE TABLE IF NOT EXISTS sync_exceptions (
  id          serial PRIMARY KEY,
  log_id      integer     REFERENCES sync_log(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  reason      text        NOT NULL,         -- 'no_combo_match', 'name_mismatch', 'constraint_violation' etc.
  entity_type text        NOT NULL,         -- 'customer_module_line', 'customer_master' etc.
  source_key  text,                         -- identifier from source (e.g. "ZohoName|Service|Workflow")
  raw_data    jsonb                         -- full source row for manual triage
);

CREATE INDEX IF NOT EXISTS idx_sync_exc_log      ON sync_exceptions (log_id);
CREATE INDEX IF NOT EXISTS idx_sync_exc_reason   ON sync_exceptions (reason);

COMMENT ON TABLE sync_exceptions IS 'Every row that a sync job could not match or process. Used for triage instead of silent skips.';

-- RLS
ALTER TABLE sync_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated can read sync_log"
  ON sync_log FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated can insert sync_log"
  ON sync_log FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "authenticated can update sync_log"
  ON sync_log FOR UPDATE TO authenticated USING (true);

CREATE POLICY "authenticated can read sync_exceptions"
  ON sync_exceptions FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated can insert sync_exceptions"
  ON sync_exceptions FOR INSERT TO authenticated WITH CHECK (true);
