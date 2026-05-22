-- Structural improvements to customer_module_lines and customer_module_mrr

-- 1. line_label: human-readable name for each billing line within a combo
--    e.g. "Distributor Users", "Field Force", "Slab 0-500"
--    Makes the 66 duplicate (zoho, service, workflow) combos distinguishable
ALTER TABLE customer_module_lines
  ADD COLUMN IF NOT EXISTS line_label   text,
  ADD COLUMN IF NOT EXISTS currency_code char(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS rate_unit    text CHECK (rate_unit IN (
    'per_user_month', 'per_user_year',
    'flat_month',     'flat_year',
    'flat_quarter',   'flat_one_time'
  )),
  ADD COLUMN IF NOT EXISTS deleted_at   timestamptz;

COMMENT ON COLUMN customer_module_lines.line_label    IS 'Human-readable label distinguishing multiple lines for the same (zoho_name, services, workflow) combo';
COMMENT ON COLUMN customer_module_lines.currency_code IS 'ISO 4217 billing currency for this line — INR, GBP, USD etc.';
COMMENT ON COLUMN customer_module_lines.rate_unit     IS 'Unit of the rate stored in customer_module_mrr — drives MRR formula';
COMMENT ON COLUMN customer_module_lines.deleted_at    IS 'Soft-delete timestamp; NULL = active. Never hard-delete billing lines.';

-- 2. Data integrity constraints on customer_module_mrr
--    These enforce that stored values are physically valid
ALTER TABLE customer_module_mrr
  ADD CONSTRAINT chk_rate_non_negative          CHECK (rate IS NULL OR rate >= 0),
  ADD CONSTRAINT chk_exchange_rate_positive     CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  ADD CONSTRAINT chk_billed_users_non_negative  CHECK (billed_users IS NULL OR billed_users >= 0),
  ADD CONSTRAINT chk_mrr_non_negative           CHECK (mrr_amount IS NULL OR mrr_amount >= 0);

-- 3. Index to support soft-delete filtering (exclude deleted lines in most queries)
CREATE INDEX IF NOT EXISTS idx_cmodl_deleted_at
  ON customer_module_lines (deleted_at)
  WHERE deleted_at IS NULL;

-- 4. Index on currency_code for FX-specific queries
CREATE INDEX IF NOT EXISTS idx_cmodl_currency
  ON customer_module_lines (currency_code);
