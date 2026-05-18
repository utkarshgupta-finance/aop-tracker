create table if not exists fx_rates (
  year_month  varchar(7)   not null,           -- 'YYYY-MM'
  currency    text         not null default 'GBP',
  rate        numeric      not null,
  updated_at  timestamptz  not null default now(),
  primary key (year_month, currency)
);

alter table fx_rates enable row level security;

create policy "authenticated can read fx_rates"
  on fx_rates for select to authenticated using (true);

create policy "authenticated can manage fx_rates"
  on fx_rates for all to authenticated using (true) with check (true);
