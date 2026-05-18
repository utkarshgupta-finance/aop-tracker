CREATE TABLE ar_invoices (
  invoice_id       TEXT PRIMARY KEY,
  invoice_number   TEXT,
  customer_name    TEXT NOT NULL,
  invoice_date     DATE,
  due_date         DATE,
  status           TEXT,
  total            NUMERIC,
  balance          NUMERIC,
  revenue_type     TEXT,
  service_from     TEXT,
  service_to       TEXT,
  reference_number TEXT,
  salesperson_name TEXT,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE ar_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated can read ar_invoices" ON ar_invoices
  FOR SELECT TO authenticated USING (true);
