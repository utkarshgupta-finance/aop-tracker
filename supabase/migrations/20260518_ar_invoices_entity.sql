ALTER TABLE ar_invoices ADD COLUMN IF NOT EXISTS entity TEXT NOT NULL DEFAULT 'IN';
CREATE INDEX IF NOT EXISTS ar_invoices_entity_idx ON ar_invoices(entity);
