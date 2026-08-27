-- Revenue loss is tracked per invoice alongside the expected credit note.
-- They are different figures: the credit note reduces what is collectable on
-- this invoice, while the revenue loss is what the business gives up — so it
-- is deliberately not capped by the invoice balance.
alter table expected_credit_notes add column revenue_loss numeric;

-- One submission covering several invoices writes a row per invoice sharing a
-- batch id, so they can be recognised later as having been raised together.
alter table expected_credit_notes add column batch_id uuid;
create index expected_cn_batch_idx on expected_credit_notes (batch_id);
