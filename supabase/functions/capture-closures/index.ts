import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Records invoices leaving the open book, so the app can answer "was that
// promise kept?" and "how long does this customer actually take to pay?".
//
// Deliberately standalone: it does NOT touch ar_invoices and does NOT modify
// sync-ar. Zoho remains the system of record — nothing here is user-entered.
// It reads the invoices sync-ar is about to delete, asks Zoho for the real
// payment date, writes a self-contained closure row, and stops.
//
// Ordering: sync-ar runs every 2h at :30 and deletes invoices Zoho no longer
// reports as unpaid. This runs at :25, five minutes ahead, while those rows
// are still present. If a run is ever missed, the nightly snapshot gives a
// safety net — ?recover=1 rebuilds closures from snapshot gaps.

const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')            ?? '';
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET')        ?? '';
const ZOHO_REFRESH_TOKEN = Deno.env.get('ZOHO_BOOKS_REFRESH_TOKEN')
                        ?? Deno.env.get('ZOHO_REFRESH_TOKEN')         ?? '';
const BOOKS_ORG_ID = '60001574931';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// IST calendar day — the app buckets everything on IST, so closures must too
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

async function getAccessToken(): Promise<{ token: string } | { error: string; detail: unknown }> {
  const resp = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET, refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  });
  const j = await resp.json();
  if (j.access_token) return { token: j.access_token };
  return { error: j.error ?? 'token_error', detail: j };
}

async function zohoPages(token: string, qs: string, onPage: (invs: any[]) => void) {
  let page = 1;
  while (true) {
    const url = `https://www.zohoapis.in/books/v3/invoices?organization_id=${BOOKS_ORG_ID}&${qs}&per_page=200&page=${page}`;
    const r = await fetch(url, { headers: { Authorization: 'Zoho-oauthtoken ' + token } });
    const d = await r.json();
    if (!r.ok || d.code !== 0) throw new Error(d.message ?? `Zoho error (HTTP ${r.status})`);
    onPage(d.invoices ?? []);
    if (!d.page_context?.has_more_page) break;
    page++;
    if (page > 60) break;                    // hard stop; never loop forever
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  const dryRun   = url.searchParams.get('dry') === '1';
  const lookback = Math.min(Number(url.searchParams.get('lookback') ?? 45) || 45, 400);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // ?recover=1 — safety net: rebuild closures from daily-snapshot gaps for
  // anything the 2-hourly pass missed. Never overwrites a Zoho-sourced row.
  if (url.searchParams.get('recover') === '1') {
    const { data, error } = await supabase.rpc('recover_closures_from_snapshots');
    if (error) return json({ ok: false, stage: 'recover', error: error.message }, 500);
    return json({ ok: true, recovered: data });
  }

  try {
    const tok = await getAccessToken();
    if ('error' in tok) return json({ ok: false, stage: 'auth', ...tok }, 500);

    // 1 — what Zoho still considers unpaid
    const openIds = new Set<string>();
    await zohoPages(tok.token, 'filter_by=Status.Unpaid&sort_column=due_date',
      invs => invs.forEach((i: any) => openIds.add(String(i.invoice_id))));
    if (!openIds.size) return json({ ok: false, stage: 'guard', message: 'Zoho returned no unpaid invoices — refusing to treat the whole book as closed.' }, 500);

    // 2 — what we still hold as open
    const { data: held, error: heldErr } = await supabase
      .from('ar_invoices')
      .select('invoice_id,invoice_number,customer_name,entity,invoice_date,due_date,balance_inr,total_inr,currency_code')
      .eq('entity', 'IN');
    if (heldErr) return json({ ok: false, stage: 'read_ar', error: heldErr.message }, 500);

    const closed = (held ?? []).filter(r => !openIds.has(String(r.invoice_id)));

    // 3 — real payment dates for recently-settled invoices
    const paid = new Map<string, any>();
    const since = new Date(Date.now() - lookback * 86400000).toISOString().slice(0, 19) + '-0000';
    await zohoPages(tok.token, `filter_by=Status.Paid&last_modified_time=${encodeURIComponent(since)}`,
      invs => invs.forEach((i: any) => paid.set(String(i.invoice_id), i)));

    // 4 — the standing promise, so a closure can be scored against it
    const ptpMap = new Map<string, any>();
    if (closed.length) {
      const { data: ptps } = await supabase
        .from('invoice_ptp').select('invoice_id,ptp_date,given_by')
        .in('invoice_id', closed.map(r => r.invoice_id));
      (ptps ?? []).forEach(p => ptpMap.set(String(p.invoice_id), p));
    }

    const today = istToday();
    const rows = closed.map(r => {
      const z  = paid.get(String(r.invoice_id));
      const wo = Number(z?.write_off_amount ?? 0);
      const basis = !z ? 'left_unpaid_book' : (wo > 0 ? 'zoho_write_off' : 'zoho_paid');
      const ptp = ptpMap.get(String(r.invoice_id));
      return {
        invoice_id:        r.invoice_id,
        invoice_number:    r.invoice_number,
        customer_name:     r.customer_name,
        entity:            r.entity ?? 'IN',
        closure_basis:     basis,
        // Zoho's own payment date when it knows one; otherwise today, which is
        // accurate to the 2h cadence since we only see this once it flips.
        closed_on:         z?.last_payment_date || today,
        last_seen_on:      today,
        amount_paid:       z ? Math.max(0, Number(z.total ?? 0) - wo) : null,
        write_off_amount:  z ? wo : null,
        last_balance_inr:  r.balance_inr,
        invoice_total_inr: r.total_inr,
        invoice_date:      r.invoice_date,
        due_date:          r.due_date,
        currency_code:     r.currency_code,
        ptp_date_at_close: ptp?.ptp_date  ?? null,
        ptp_given_by:      ptp?.given_by  ?? null,
        updated_at:        new Date().toISOString(),
      };
    });

    // 5 — upgrade earlier guesses now that Zoho has told us the real date
    const upgrades: any[] = [];
    if (paid.size) {
      const { data: weak } = await supabase
        .from('invoice_closures').select('invoice_id')
        .in('closure_basis', ['snapshot_gap', 'left_unpaid_book']);
      for (const w of weak ?? []) {
        const z = paid.get(String(w.invoice_id));
        if (!z) continue;
        const wo = Number(z.write_off_amount ?? 0);
        upgrades.push({
          invoice_id:       w.invoice_id,
          closure_basis:    wo > 0 ? 'zoho_write_off' : 'zoho_paid',
          closed_on:        z.last_payment_date || null,
          amount_paid:      Math.max(0, Number(z.total ?? 0) - wo),
          write_off_amount: wo,
          updated_at:       new Date().toISOString(),
        });
      }
    }

    // 6 — an invoice back in the unpaid list was never really closed
    const { data: stale } = await supabase
      .from('invoice_closures').select('invoice_id').eq('entity', 'IN');
    const reversed = (stale ?? []).map(s => String(s.invoice_id)).filter(id => openIds.has(id));

    if (dryRun) {
      return json({ ok: true, dry_run: true, zoho_open: openIds.size, held: held?.length ?? 0,
        would_write: rows.length, by_basis: rows.reduce((a: any, r) => (a[r.closure_basis] = (a[r.closure_basis] ?? 0) + 1, a), {}),
        would_upgrade: upgrades.length, would_reverse: reversed.length, sample: rows.slice(0, 3) });
    }

    let written = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('invoice_closures')
        .upsert(rows.slice(i, i + 200), { onConflict: 'invoice_id' });
      if (error) return json({ ok: false, stage: 'write', error: error.message }, 500);
      written += rows.slice(i, i + 200).length;
    }
    for (const u of upgrades) {
      await supabase.from('invoice_closures').update(u).eq('invoice_id', u.invoice_id);
    }
    if (reversed.length) {
      await supabase.from('invoice_closures').delete().in('invoice_id', reversed);
    }

    return json({ ok: true, zoho_open: openIds.size, held: held?.length ?? 0,
      written, upgraded: upgrades.length, reversed: reversed.length,
      by_basis: rows.reduce((a: any, r) => (a[r.closure_basis] = (a[r.closure_basis] ?? 0) + 1, a), {}) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
