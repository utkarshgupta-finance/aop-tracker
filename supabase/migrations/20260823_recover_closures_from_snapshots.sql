-- Safety net for the 2-hourly capture. If a run is missed, sync-ar deletes the
-- ar_invoices row and the closure would be lost; the nightly snapshot still
-- holds it, so a gap between consecutive snapshots reconstructs the closure.
-- Never overwrites a row already sourced from Zoho (on conflict do nothing).
create or replace function recover_closures_from_snapshots()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare inserted integer;
begin
  with days as (select distinct snapshot_date d from ar_invoice_snapshots),
       seq  as (select d, lead(d) over (order by d) nxt from days),
       present as (select snapshot_date d, invoice_id from ar_invoice_snapshots group by 1,2),
       gone as (
         select p.invoice_id, s.nxt as gone_on
         from seq s
         join present p on p.d = s.d
         left join present p2 on p2.d = s.nxt and p2.invoice_id = p.invoice_id
         where s.nxt is not null and p2.invoice_id is null
       ),
       final as (select invoice_id, max(gone_on) gone_on from gone group by 1),
       lastsnap as (
         select distinct on (s.invoice_id)
                s.invoice_id, s.invoice_number, s.customer_name, s.entity,
                s.invoice_date, s.due_date, s.balance_inr, s.total_inr,
                s.currency_code, s.snapshot_date
         from ar_invoice_snapshots s
         join final f on f.invoice_id = s.invoice_id
         where s.snapshot_date < f.gone_on
         order by s.invoice_id, s.snapshot_date desc
       )
  insert into invoice_closures (
    invoice_id, invoice_number, customer_name, entity, closure_basis,
    closed_on, last_seen_on, last_balance_inr, invoice_total_inr,
    invoice_date, due_date, currency_code, ptp_date_at_close, ptp_given_by)
  select l.invoice_id, l.invoice_number, l.customer_name, coalesce(l.entity,'IN'),
         'snapshot_gap', f.gone_on, l.snapshot_date,
         l.balance_inr, l.total_inr, l.invoice_date, l.due_date, l.currency_code,
         p.ptp_date, p.given_by
  from lastsnap l
  join final f on f.invoice_id = l.invoice_id
  left join invoice_ptp p on p.invoice_id = l.invoice_id
  where not exists (select 1 from ar_invoices a where a.invoice_id = l.invoice_id)
  on conflict (invoice_id) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;
