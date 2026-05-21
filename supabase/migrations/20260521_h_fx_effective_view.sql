-- FX effective rate view: resolves authoritative exchange rate for each
-- customer_module_mrr row.
--
-- Problem: exchange_rate is stored per-line per-month in customer_module_mrr
-- (copied from Excel). GBP/INR on a given date is a single market fact —
-- storing it per-line means it can drift between customers for the same month.
-- The canonical source is the fx_rates table.
--
-- Resolution rule:
--   1. If line currency = 'INR' → effective_rate = 1 (no conversion needed)
--   2. Otherwise → use fx_rates.rate for (currency, month)
--   3. Fallback → use stored customer_module_mrr.exchange_rate (manual override)
--   4. Final fallback → 1 (no conversion, conservative)

CREATE OR REPLACE VIEW customer_module_mrr_with_fx AS
SELECT
  cmrr.*,
  cml.currency_code,
  CASE
    WHEN cml.currency_code IS NULL OR cml.currency_code = 'INR' THEN 1.0
    ELSE COALESCE(
      fx.rate,
      cmrr.exchange_rate,
      1.0
    )
  END AS effective_exchange_rate,
  -- Pre-computed INR amount using the authoritative rate
  CASE
    WHEN cml.currency_code IS NULL OR cml.currency_code = 'INR'
      THEN cmrr.mrr_amount
    ELSE ROUND(
      cmrr.mrr_amount * COALESCE(fx.rate, cmrr.exchange_rate, 1.0),
      2
    )
  END AS mrr_amount_inr
FROM customer_module_mrr         cmrr
JOIN customer_module_lines        cml  ON cml.id = cmrr.module_line_id
LEFT JOIN fx_rates                fx
       ON fx.year_month = TO_CHAR(cmrr.month_date, 'YYYY-MM')
      AND fx.currency   = cml.currency_code
      AND cml.currency_code <> 'INR';

COMMENT ON VIEW customer_module_mrr_with_fx IS
  'Adds effective_exchange_rate (from fx_rates canonical source, fallback to stored value) '
  'and mrr_amount_inr (pre-converted) to every customer_module_mrr row.';

-- Usage example:
-- SELECT zoho_name, month_date, SUM(mrr_amount_inr) AS total_inr_mrr
-- FROM customer_module_mrr_with_fx f
-- JOIN customer_module_lines cml ON cml.id = f.module_line_id
-- WHERE month_date = '2026-03-01'
-- GROUP BY zoho_name, month_date
-- ORDER BY total_inr_mrr DESC;
