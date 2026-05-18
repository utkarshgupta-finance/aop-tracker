create table if not exists ar_invoice_snapshots (
  id               uuid        primary key default gen_random_uuid(),
  snapshot_date    date        not null,
  received_at      timestamptz not null default now(),
  entity           text        not null,
  invoice_id       text        not null,
  invoice_number   text,
  customer_name    text,
  invoice_date     date,
  due_date         date,
  status           text,
  total            numeric,
  balance          numeric,
  currency_code    text        default 'INR',
  exchange_rate    numeric     default 1,
  total_inr        numeric,
  balance_inr      numeric,
  unique (invoice_id, snapshot_date, entity)
);

create index if not exists ar_snapshots_date_idx   on ar_invoice_snapshots (snapshot_date);
create index if not exists ar_snapshots_entity_idx on ar_invoice_snapshots (entity);
create index if not exists ar_snapshots_inv_idx    on ar_invoice_snapshots (invoice_id);

alter table ar_invoice_snapshots enable row level security;

create policy "authenticated can read ar_invoice_snapshots"
  on ar_invoice_snapshots for select
  to authenticated using (true);
