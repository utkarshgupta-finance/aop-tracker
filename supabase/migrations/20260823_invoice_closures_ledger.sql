-- Records an invoice leaving the open book. Zoho stays the system of record:
-- nothing here is user-entered, and ar_invoices keeps meaning "open invoices".
-- Rows are self-contained (invoice/due dates, balance and standing PTP frozen
-- in) because the ar_invoices row is deleted moments later, so metrics must not
-- need a join to something that no longer exists.
create table invoice_closures (
  invoice_id        text primary key,
  invoice_number    text,
  customer_name     text not null,
  entity            text not null default 'IN',

  -- 'zoho_paid'        real payment date from Zoho
  -- 'zoho_write_off'   left the book via a write-off, not cash
  -- 'left_unpaid_book' gone from Zoho's unpaid list, reason unknown
  -- 'snapshot_gap'     inferred from a daily-snapshot gap (backfill/recovery)
  closure_basis     text not null,
  closed_on         date,
  last_seen_on      date,

  amount_paid       numeric,
  write_off_amount  numeric,
  last_balance_inr  numeric,
  invoice_total_inr numeric,

  invoice_date      date,
  due_date          date,
  currency_code     text,

  ptp_date_at_close date,
  ptp_given_by      text,

  days_to_pay       int generated always as (closed_on - invoice_date) stored,
  days_late         int generated always as (closed_on - due_date)     stored,

  detected_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index invoice_closures_customer_idx on invoice_closures (customer_name);
create index invoice_closures_closed_on_idx on invoice_closures (closed_on);
create index invoice_closures_basis_idx     on invoice_closures (closure_basis);

alter table invoice_closures enable row level security;
create policy authenticated_all on invoice_closures for all to authenticated using (true) with check (true);
