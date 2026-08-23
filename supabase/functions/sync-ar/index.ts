import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')          ?? '';
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET')       ?? '';
const ZOHO_REFRESH_TOKEN = Deno.env.get('ZOHO_BOOKS_REFRESH_TOKEN')
                        ?? Deno.env.get('ZOHO_REFRESH_TOKEN')        ?? '';
const BOOKS_ORG_ID = '60001574931';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

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

function sseStream() {
  let controller: ReadableStreamDefaultController;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const enc = new TextEncoder();
  const send = (event: string, data: unknown) =>
    controller!.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const close = () => controller!.close();
  const response = new Response(stream, {
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
  return { response, send, close };
}

// NOTE: this function only keeps ar_invoices current. Daily snapshots are the
// sole responsibility of the take_ar_snapshot() Postgres RPC (IST-aware,
// atomic delete+insert of the whole table, called by its own nightly cron and
// the admin "Take Today's Snapshot" button). This function used to ALSO write
// ar_invoice_snapshots directly on its end-of-day cron run, using a UTC-based
// date and an upsert-only write that never cleared stale rows — a second,
// uncoordinated writer that could mislabel snapshot_date around IST midnight
// and leave today's snapshot inconsistent with the RPC's full rebuild. Removed.
async function runSync(notify: (event: string, data: unknown) => void) {
  const tok = await getAccessToken();
  if ('error' in tok) { notify('error', { message: `Zoho auth failed: ${tok.error}`, detail: tok.detail }); return null; }

  type InvRow = Record<string, unknown>;
  const rows: InvRow[] = [];
  const syncedAt = new Date().toISOString();
  let page = 1;

  while (true) {
    const apiUrl = `https://www.zohoapis.in/books/v3/invoices?organization_id=${BOOKS_ORG_ID}&filter_by=Status.Unpaid&per_page=200&page=${page}&sort_column=due_date`;
    const resp = await fetch(apiUrl, { headers: { Authorization: 'Zoho-oauthtoken ' + tok.token } });
    const data = await resp.json();
    if (!resp.ok || data.code !== 0) {
      notify('error', { message: data.message ?? 'Zoho Books API error', code: data.code, http_status: resp.status });
      return null;
    }
    for (const inv of data.invoices ?? []) {
      const total        = Number(inv.total         ?? 0);
      const balance      = Number(inv.balance       ?? 0);
      const exchangeRate = Number(inv.exchange_rate ?? 1) || 1;
      rows.push({
        invoice_id:       inv.invoice_id,
        invoice_number:   inv.invoice_number,
        customer_name:    inv.customer_name,
        invoice_date:     inv.date      || null,
        due_date:         inv.due_date  || null,
        status:           inv.status,
        entity:           'IN',
        currency_code:    inv.currency_code || 'INR',
        exchange_rate:    exchangeRate,
        total,
        balance,
        total_inr:        Math.round(total   * exchangeRate * 100) / 100,
        balance_inr:      Math.round(balance * exchangeRate * 100) / 100,
        revenue_type:     inv.cf_revenue_type     || null,
        service_from:     inv.cf_new_service_from || null,
        service_to:       inv.cf_new_service_to   || null,
        reference_number: inv.reference_number    || null,
        salesperson_name: inv.salesperson_name    || null,
        invoice_url:      inv.invoice_url         || null,
        synced_at:        syncedAt,
      });
    }
    notify('progress', { step: 2, total: 3, message: `Fetched page ${page} of ${data.page_context?.total_pages ?? '?'} — ${rows.length} invoices…` });
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  notify('progress', { step: 3, total: 3, message: `Saving ${rows.length} invoices…` });
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('ar_invoices').upsert(rows.slice(i, i + 500), { onConflict: 'invoice_id' });
    if (error) { notify('error', { message: 'Upsert failed: ' + error.message }); return null; }
  }

  // Remove invoices Zoho no longer reports as unpaid.
  //
  // This used to send every KEPT id in a single `not.in.(…)` filter — roughly
  // an 18KB URL at today's ~850 invoices, and past the request URL limit well
  // before the 3000-row fetch cap above. When that limit is crossed the delete
  // fails, and because the failure is only a progress note the sync still
  // reports success: the sole symptom is paid invoices lingering in Open AR.
  //
  // Now the ids to remove are computed here and deleted explicitly in chunks,
  // so the URL stays small and nothing is ever deleted by exclusion.
  if (rows.length > 0) {
    const keep = new Set(rows.map(r => String(r.invoice_id)));
    // Explicit limit: the default cap is 1000 rows, which would silently
    // truncate this read once the book grows past it and leave stale invoices
    // behind. Kept above the 3000-row fetch cap used for the Zoho pull.
    const { data: heldRows, error: readErr } = await supabase
      .from('ar_invoices').select('invoice_id').eq('entity', 'IN').limit(5000);

    if (readErr) {
      notify('progress', { step: 3, total: 3, message: `Cleanup skipped — could not read current rows: ${readErr.message}` });
    } else {
      const stale = (heldRows ?? []).map(r => String(r.invoice_id)).filter(id => !keep.has(id));
      // Safety valve: a couple of dozen invoices close in a normal day. A jump
      // this large means Zoho returned a partial book, so leave the table alone
      // and say so loudly rather than deleting most of Open AR.
      if (stale.length > 200) {
        notify('progress', { step: 3, total: 3, message: `Cleanup skipped — ${stale.length} invoices would be removed, which is implausible. Zoho likely returned a partial list. No rows deleted.` });
      } else {
        for (let i = 0; i < stale.length; i += 200) {
          const { error: delErr } = await supabase
            .from('ar_invoices').delete()
            .in('invoice_id', stale.slice(i, i + 200));
          if (delErr) { notify('progress', { step: 3, total: 3, message: `Cleanup warning: ${delErr.message}` }); break; }
        }
        if (stale.length) notify('progress', { step: 3, total: 3, message: `Removed ${stale.length} settled invoice${stale.length === 1 ? '' : 's'}.` });
      }
    }
  }

  return { synced: rows.length, pages: page };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);

  // ?test=1 — auth + sample check, no DB write
  if (url.searchParams.get('test') === '1') {
    const tok = await getAccessToken();
    if ('error' in tok) return json({ stage: 'auth', ...tok }, 500);
    const r = await fetch(
      `https://www.zohoapis.in/books/v3/invoices?organization_id=${BOOKS_ORG_ID}&filter_by=Status.Unpaid&per_page=5&page=1`,
      { headers: { Authorization: 'Zoho-oauthtoken ' + tok.token } }
    );
    const data = await r.json();
    return json({ stage: 'books_api', http_status: r.status, zoho_code: data.code, message: data.message, page_context: data.page_context, sample_count: data.invoices?.length, sample: data.invoices?.slice(0, 1) });
  }

  // ?cron=1 — synchronous JSON mode for scheduled runs
  if (url.searchParams.get('cron') === '1') {
    const log: unknown[] = [];
    const notify = (_: string, data: unknown) => log.push(data);
    try {
      notify('progress', { step: 1, total: 3, message: 'Authenticating with Zoho Books…' });
      const result = await runSync(notify);
      if (!result) return json({ ok: false, log }, 500);
      return json({ ok: true, ...result, log });
    } catch (e) {
      return json({ ok: false, error: String(e), log }, 500);
    }
  }

  // Default: SSE streaming mode for the UI
  const { response, send, close } = sseStream();

  (async () => {
    try {
      send('progress', { step: 1, total: 3, message: 'Authenticating with Zoho Books…' });
      const result = await runSync(send);
      if (result) send('done', result);
    } catch (e) {
      send('error', { message: String(e) });
    } finally {
      close();
    }
  })();

  return response;
});
