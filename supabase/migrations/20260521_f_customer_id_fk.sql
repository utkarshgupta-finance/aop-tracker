-- Add customer_id FK to customer_mrr_lines and customer_module_lines
-- Replace string-based joins with proper referential integrity.
-- zoho_name columns are KEPT (not dropped) for backwards compatibility
-- with existing app queries — they become redundant and can be dropped in a future migration
-- once all app code moves to customer_id.

-- ── customer_mrr_lines ───────────────────────────────────────────────────────

ALTER TABLE customer_mrr_lines
  ADD COLUMN IF NOT EXISTS customer_id integer REFERENCES customer_master(id);

-- Backfill: dot-normalised case-insensitive match
UPDATE customer_mrr_lines cml
SET customer_id = cm.id
FROM customer_master cm
WHERE cml.customer_id IS NULL
  AND LOWER(TRIM(TRAILING '.' FROM cml.zoho_name))
    = LOWER(TRIM(TRAILING '.' FROM cm.zoho_name));

CREATE INDEX IF NOT EXISTS idx_cmrrl_customer_id ON customer_mrr_lines (customer_id);

-- ── customer_module_lines ────────────────────────────────────────────────────

ALTER TABLE customer_module_lines
  ADD COLUMN IF NOT EXISTS customer_id integer REFERENCES customer_master(id);

-- Backfill: same normalisation rule
UPDATE customer_module_lines cmod
SET customer_id = cm.id
FROM customer_master cm
WHERE cmod.customer_id IS NULL
  AND LOWER(TRIM(TRAILING '.' FROM cmod.zoho_name))
    = LOWER(TRIM(TRAILING '.' FROM cm.zoho_name));

CREATE INDEX IF NOT EXISTS idx_cmodl_customer_id ON customer_module_lines (customer_id);

-- ── Verification queries ─────────────────────────────────────────────────────
-- Run these after migration:
--
-- Unmatched mrr_lines (should be 0 after migration e runs first):
--   SELECT id, zoho_name FROM customer_mrr_lines WHERE customer_id IS NULL;
--
-- Unmatched module_lines (may have some for renamed customers like Excite Panacea):
--   SELECT zoho_name, COUNT(*) FROM customer_module_lines
--   WHERE customer_id IS NULL GROUP BY zoho_name ORDER BY 2 DESC;
