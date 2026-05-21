-- Merge customer_mrr (historical, 29,176 rows) into customer_module_mrr
-- creating a single source of truth for all MRR data.
--
-- Strategy:
--   1. Add mrr_line_ref to customer_module_lines — tracks which historical
--      mrr_lines row a marker line came from (data lineage).
--   2. Create one "_historical" marker customer_module_lines row per
--      customer_mrr_lines row — these carry the historical CMRR total.
--   3. Migrate all customer_mrr monthly rows into customer_module_mrr
--      via the marker lines.
--   4. Rebuild customer_mrr_unified as a view on customer_module_mrr only.
--
-- After this migration:
--   customer_mrr and customer_mrr_lines are READ-ONLY archives.
--   All MRR queries go through customer_module_mrr + customer_module_lines.
--
-- IMPORTANT: Run migrations e and f BEFORE this one.
-- IMPORTANT: Verify row counts with the queries at the bottom before trusting results.

-- ── Step 1: Add lineage column ────────────────────────────────────────────────

ALTER TABLE customer_module_lines
  ADD COLUMN IF NOT EXISTS mrr_line_ref integer REFERENCES customer_mrr_lines(id);

CREATE INDEX IF NOT EXISTS idx_cmodl_mrr_line_ref
  ON customer_module_lines (mrr_line_ref);

-- ── Step 2: Create historical marker module lines ─────────────────────────────
-- One row per customer_mrr_lines row (preserving sub-customer granularity
-- e.g. Parle's 17 lines, each with its own segment/BU on customer_mrr_lines).
-- Services = '_historical', workflow = '_cmrr_total' → filtered out in UI
-- queries via &services=neq._historical

INSERT INTO customer_module_lines (
  zoho_name,
  customer_id,
  services,
  workflow,
  line_label,
  mrr_line_ref,
  status,
  currency_code
)
SELECT
  cml.zoho_name,
  cml.customer_id,
  '_historical',
  '_cmrr_total',
  'Historical CMRR (pre-Apr 2025)',
  cml.id,
  CASE
    WHEN cml.churn_date IS NOT NULL AND cml.churn_date <= CURRENT_DATE THEN 'Inactive'
    ELSE 'Active'
  END,
  'INR'
FROM customer_mrr_lines cml
WHERE NOT EXISTS (
  SELECT 1 FROM customer_module_lines cmod
  WHERE cmod.mrr_line_ref = cml.id
);

-- ── Step 3: Migrate customer_mrr → customer_module_mrr ────────────────────────
-- 29,176 rows × 1 = 29,176 inserts (no duplication risk — mrr_line_ref is unique
-- per marker line and month_date won't overlap with FY26 Apr-2025+ data).

INSERT INTO customer_module_mrr (module_line_id, month_date, mrr_amount)
SELECT
  cmod.id AS module_line_id,
  hist.month_date,
  hist.mrr_amount
FROM customer_mrr hist
JOIN customer_mrr_lines       cml  ON cml.id  = hist.mrr_line_id
JOIN customer_module_lines    cmod ON cmod.mrr_line_ref = cml.id
  AND cmod.services = '_historical'
WHERE NOT EXISTS (
  SELECT 1 FROM customer_module_mrr m
  WHERE m.module_line_id = cmod.id
    AND m.month_date     = hist.month_date
);

-- ── Step 4: Rebuild customer_mrr_unified view ─────────────────────────────────
-- Interface preserved: (zoho_name TEXT, month_date DATE, mrr_amount NUMERIC)
-- zoho_name comes from customer_module_lines (same source as before — NOT from
-- customer_master — so names are exactly the same as the pre-migration view).
-- Zero-amount rows excluded to match historical non-zero-only policy.

CREATE OR REPLACE VIEW customer_mrr_unified AS
SELECT
  cml.zoho_name,
  cmrr.month_date,
  SUM(cmrr.mrr_amount) AS mrr_amount
FROM customer_module_mrr        cmrr
JOIN  customer_module_lines     cml  ON cml.id = cmrr.module_line_id
WHERE cml.deleted_at IS NULL
  AND cmrr.mrr_amount <> 0
GROUP BY cml.zoho_name, cmrr.month_date;

-- RLS note: customer_mrr_unified inherits RLS from the underlying tables.
-- Ensure authenticated users can read customer_module_lines (should already be set).

-- ── Verification queries (run BEFORE trusting the new view) ───────────────────
--
-- 1. Row counts must match:
--    SELECT COUNT(*) FROM customer_mrr WHERE mrr_amount <> 0;   -- should be ~29,176
--    SELECT COUNT(*) FROM customer_module_mrr cmrr
--      JOIN customer_module_lines cml ON cml.id = cmrr.module_line_id
--      WHERE cml.services = '_historical';                        -- should equal above
--
-- 2. Total MRR for a sample month must match old and new view:
--    -- Old (query customer_mrr directly):
--    SELECT SUM(mrr_amount) FROM customer_mrr WHERE month_date = '2024-03-01';
--    -- New (query unified view):
--    SELECT SUM(mrr_amount) FROM customer_mrr_unified WHERE month_date = '2024-03-01';
--    -- These must be equal.
--
-- 3. Check no Apr-2025+ data was overwritten:
--    SELECT COUNT(*) FROM customer_module_mrr cmrr
--      JOIN customer_module_lines cml ON cml.id = cmrr.module_line_id
--      WHERE cml.services <> '_historical' AND cmrr.month_date >= '2025-04-01';
--    -- Should equal original 21,624 (FY26 module rows).
