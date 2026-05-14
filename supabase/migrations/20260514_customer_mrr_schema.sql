-- Add ERTM BU to bu_master
INSERT INTO bu_master (name, code) VALUES ('ERTM BU', 'ERTM');

-- Segment master (SME, Mid_Market, Enterprise, ERTM India)
CREATE TABLE segment_master (
  id   serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

-- Customer MRR line items: one row per distinct CMRR tracking line
-- Segment and BU live here (not on customer_master) to support group customers
-- (e.g. Parle Group has 17 lines spanning different BUs)
CREATE TABLE customer_mrr_lines (
  id              serial PRIMARY KEY,
  zoho_name       text,
  cmrr_name       text,
  regrouped_name  text,
  go_live_date    date,
  churn_date      date,
  segment_id      integer REFERENCES segment_master(id),
  bu_id           integer REFERENCES bu_master(id)
);

CREATE INDEX idx_cml_zoho_name       ON customer_mrr_lines (zoho_name);
CREATE INDEX idx_cml_regrouped_name  ON customer_mrr_lines (regrouped_name);
CREATE INDEX idx_cml_segment         ON customer_mrr_lines (segment_id);
CREATE INDEX idx_cml_bu              ON customer_mrr_lines (bu_id);

-- Customer MRR: narrow format — one row per line × month (non-zero only)
-- Source: Customer MRR - Total sheet, Apr 2017 → Mar 2025, 1,052 lines, 29,176 rows
CREATE TABLE customer_mrr (
  id           serial PRIMARY KEY,
  mrr_line_id  integer NOT NULL REFERENCES customer_mrr_lines(id),
  month_date   date    NOT NULL,
  mrr_amount   numeric(14,2) NOT NULL
);

CREATE INDEX idx_cmrr_line_id    ON customer_mrr (mrr_line_id);
CREATE INDEX idx_cmrr_month      ON customer_mrr (month_date);
CREATE INDEX idx_cmrr_line_month ON customer_mrr (mrr_line_id, month_date);
