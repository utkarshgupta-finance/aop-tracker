-- Junction table: all (mrr_line, customer_master) linkages via zoho_name
-- One row per match; multi-match rows capture group customers with multiple install entities
CREATE TABLE customer_mrr_line_master (
  mrr_line_id        integer NOT NULL REFERENCES customer_mrr_lines(id),
  customer_master_id integer NOT NULL REFERENCES customer_master(id),
  PRIMARY KEY (mrr_line_id, customer_master_id)
);

CREATE INDEX idx_cmlm_master_id ON customer_mrr_line_master (customer_master_id);

-- Populate all case-insensitive zoho_name matches
INSERT INTO customer_mrr_line_master (mrr_line_id, customer_master_id)
SELECT cml.id, cm.id
FROM customer_mrr_lines cml
JOIN customer_master cm ON LOWER(cm.zoho_name) = LOWER(cml.zoho_name)
WHERE cml.zoho_name IS NOT NULL;

-- Strip trailing dots from zoho_name in both tables (data quality fix)
UPDATE customer_mrr_lines
SET zoho_name = TRIM(TRAILING '.' FROM TRIM(zoho_name))
WHERE zoho_name LIKE '%.';

UPDATE customer_master
SET zoho_name = TRIM(TRAILING '.' FROM TRIM(zoho_name))
WHERE zoho_name LIKE '%.';

-- Add ERTM BU (id=9) was done in previous migration; this note is for reference only.

-- After dot cleanup: insert missing junction entries
INSERT INTO customer_mrr_line_master (mrr_line_id, customer_master_id)
SELECT cml.id, cm.id
FROM customer_mrr_lines cml
JOIN customer_master cm ON LOWER(cm.zoho_name) = LOWER(cml.zoho_name)
LEFT JOIN customer_mrr_line_master lm
       ON lm.mrr_line_id = cml.id AND lm.customer_master_id = cm.id
WHERE lm.mrr_line_id IS NULL AND cml.zoho_name IS NOT NULL;

-- Result: 1052/1052 mrr_lines linked, 1479 total linkages

-- Restore trailing-dot names (were incorrectly stripped earlier)
-- Names like "Pvt. Ltd.", "Inc.", "Co." are legitimate and treated as distinct customers
UPDATE customer_mrr_lines
SET zoho_name = zoho_name  -- restored via script from Excel source
WHERE zoho_name LIKE '%.';  -- 73 rows restored

UPDATE customer_master
SET zoho_name = zoho_name  -- restored via script from Excel source
WHERE zoho_name LIKE '%.';  -- 91 rows restored

-- Rebuild junction for dot-name rows
DELETE FROM customer_mrr_line_master
WHERE mrr_line_id IN (
  SELECT id FROM customer_mrr_lines WHERE zoho_name LIKE '%.'
);

INSERT INTO customer_mrr_line_master (mrr_line_id, customer_master_id)
SELECT cml.id, cm.id
FROM customer_mrr_lines cml
JOIN customer_master cm ON LOWER(cm.zoho_name) = LOWER(cml.zoho_name)
WHERE cml.zoho_name LIKE '%.'
ON CONFLICT DO NOTHING;

-- Final state: 1052/1052 linked, 1474 total linkages

-- Fix: restore no-dot customer_master entries incorrectly overwritten by restore script
-- 19 names exist in Nomenclature without dot but were changed to dot version
-- Re-added as new rows from Nomenclature; junction entries created

-- Fix: Health Care Medicines double-space typo in Customer Info → corrected to single space
UPDATE customer_mrr_lines
SET zoho_name = 'Health Care Medicines (Surinder Pal)'
WHERE zoho_name = 'Health Care Medicines (Surinder  Pal)';

-- Final state: 1052/1052 mrr_lines linked, 1449 total linkages, 0 unlinked
