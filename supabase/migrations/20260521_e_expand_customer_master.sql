-- Expand customer_master to include ALL historical customers from customer_mrr_lines
-- customer_master currently only has ~1,458 rows but customer_mrr_lines references
-- ~346 customers that churned and were removed from customer_master over time.
-- customer_master must be the complete customer registry — active AND churned.
-- These rows are inserted with is_historical = true so reporting can exclude them.

ALTER TABLE customer_master
  ADD COLUMN IF NOT EXISTS is_historical boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN customer_master.is_historical IS
  'True for customers added from historical mrr data who are not tracked in Zoho CRM today.';

-- Insert all mrr_lines customers not already in customer_master
-- Match rule: LOWER(TRIM(TRAILING '.' FROM zoho_name)) equality
INSERT INTO customer_master (zoho_name, regrouped_name, cmrr_name, is_historical)
SELECT DISTINCT ON (LOWER(TRIM(TRAILING '.' FROM cml.zoho_name)))
  cml.zoho_name,
  cml.regrouped_name,
  cml.cmrr_name,
  true
FROM customer_mrr_lines cml
WHERE cml.zoho_name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM customer_master cm
    WHERE LOWER(TRIM(TRAILING '.' FROM cm.zoho_name))
        = LOWER(TRIM(TRAILING '.' FROM cml.zoho_name))
  )
ORDER BY LOWER(TRIM(TRAILING '.' FROM cml.zoho_name)), cml.id;

-- Verification query (run after migration to confirm):
-- SELECT COUNT(*) FROM customer_master WHERE is_historical = true;
-- SELECT COUNT(*) FROM customer_mrr_lines cml
--   WHERE NOT EXISTS (
--     SELECT 1 FROM customer_master cm
--     WHERE LOWER(TRIM(TRAILING '.' FROM cm.zoho_name))
--         = LOWER(TRIM(TRAILING '.' FROM cml.zoho_name))
--   );
-- Second query should return 0.
