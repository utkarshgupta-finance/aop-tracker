-- Reasons a credit note is expected. Editable in Settings, same shape as the
-- other option masters (advance_action_options, contact_categories).
create table cn_reason_options (
  id         uuid primary key default gen_random_uuid(),
  value      text not null unique,
  label      text not null,
  sort_order int  not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
insert into cn_reason_options (value, label, sort_order) values
  ('user_count_issue',       'User Count Issue',       1),
  ('service_issue',          'Service Issue',          2),
  ('implementation_pending', 'Implementation Pending', 3),
  ('service_discontinued',   'Service Discontinued',   4),
  ('churned',                'Churned',                5),
  ('price_change',           'Price Change',           6),
  ('mug_change',             'MUG Change',             7),
  ('others',                 'Others',                 8);

-- A credit note the AR team expects to be raised against an invoice. Open ones
-- reduce what is realistically collectable, so Open AR surfaces them per
-- invoice. Zoho remains the system of record for credit notes actually issued;
-- this only tracks the expectation and how it was settled.
create table expected_credit_notes (
  id              uuid primary key default gen_random_uuid(),
  customer_name   text not null,
  invoice_id      text,
  invoice_number  text,
  entity          text default 'IN',
  reason          text not null,
  details         text,
  email_subject   text,
  expected_amount numeric,

  status          text not null default 'open',   -- 'open' | 'closed'
  closure_type    text,                           -- 'cn_issued' | 'not_required'
  cn_number       text,
  closure_reason  text,

  created_by      uuid,
  created_by_name text,
  created_at      timestamptz not null default now(),
  closed_by       uuid,
  closed_by_name  text,
  closed_at       timestamptz,

  constraint expected_cn_status_chk check (status in ('open','closed')),
  -- a closed row must say how, and carry the evidence that closure demands
  constraint expected_cn_closure_chk check (
    status = 'open'
    or (closure_type = 'cn_issued'    and coalesce(cn_number, '')      <> '')
    or (closure_type = 'not_required' and coalesce(closure_reason, '') <> '')
  )
);

create index expected_cn_customer_idx on expected_credit_notes (customer_name);
create index expected_cn_invoice_idx  on expected_credit_notes (invoice_id);
create index expected_cn_status_idx   on expected_credit_notes (status);

alter table cn_reason_options      enable row level security;
alter table expected_credit_notes  enable row level security;
create policy authenticated_all on cn_reason_options     for all to authenticated using (true) with check (true);
create policy authenticated_all on expected_credit_notes for all to authenticated using (true) with check (true);
