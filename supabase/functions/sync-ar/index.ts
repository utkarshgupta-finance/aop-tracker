import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')          ?? '';
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET')       ?? '';
// Prefer a Books-specific refresh token; fall back to the CRM one
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

// SSE helper
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);

  // ?test=1 — auth check + page 1 sample, no DB write
  if (url.searchParams.get('test') === '1') {
    const tok = await getAccessToken();
    if ('error' in tok) return json({ stage: 'auth', ...tok }, 500);
    const r = await fetch(
      `https://www.zohoapis.in/books/v3/invoices?organization_id=${BOOKS_ORG_ID}&filter_by=Status.Unpaid&per_page=5&page=1`,
      { headers: { Authorization: 'Zoho-oauthtoken ' + tok.token } }
    );
    const data = await r.json();
    return json({ stage: 'books_api', http_status: r.status, zoho_code: data.code, message: data.message, page_context: data.page_context, sample_count: data.invoices?.length, sample: data.invoices?.slice(0,1) });
  }

  // Streaming SSE sync
  const { response, send, close } = sseStream();

  (async () => {
    try {
      send('progress', { step: 1, total: 3, message: 'Authenticating with Zoho Books…' });
      const tok = await getAccessToken();
      if ('error' in tok) {
        send('error', { message: `Zoho auth failed: ${tok.error}`, detail: tok.detail });
        close(); return;
      }

      send('progress', { step: 2, total: 3, message: 'Fetching open invoices from Zoho Books…' });
      type InvRow = Record<string, unknown>;
      const rows: InvRow[] = [];
      const syncedAt = new Date().toISOString();
      let page = 1;

      while (true) {
        const apiUrl = `https://www.zohoapis.in/books/v3/invoices?organization_id=${BOOKS_ORG_ID}&filter_by=Status.Unpaid&per_page=200&page=${page}&sort_column=due_date`;
        const resp = await fetch(apiUrl, { headers: { Authorization: 'Zoho-oauthtoken ' + tok.token } });
        const data = await resp.json();
        if (!resp.ok || data.code !== 0) {
          send('error', { message: data.message ?? 'Zoho Books API error', code: data.code, http_status: resp.status });
          close(); return;
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
            total:            total,
            balance:          balance,
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
        const ctx = data.page_context;
        send('progress', { step: 2, total: 3, message: `Fetched page ${page} of ${ctx?.total_pages ?? '?'} — ${rows.length} invoices…` });
        if (!ctx?.has_more_page) break;
        page++;
      }

      send('progress', { step: 3, total: 3, message: `Saving ${rows.length} invoices to database…` });
      const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

      // Upsert in batches — idempotent, no data loss on repeated syncs
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase
          .from('ar_invoices')
          .upsert(rows.slice(i, i + 500), { onConflict: 'invoice_id' });
        if (error) { send('error', { message: 'Upsert failed: ' + error.message }); close(); return; }
      }

      // Remove India invoices that are no longer open (scoped to entity=IN only)
      if (rows.length > 0) {
        const ids = rows.map(r => r.invoice_id as string);
        const { error: delErr } = await supabase
          .from('ar_invoices')
          .delete()
          .eq('entity', 'IN')
          .not('invoice_id', 'in', `(${ids.map(id => `"${id}"`).join(',')})`);
        if (delErr) {
          send('progress', { step: 3, total: 3, message: `Note: cleanup of closed invoices failed: ${delErr.message}` });
        }
      }

      // Write historical snapshot (idempotent — unique on invoice_id + snapshot_date + entity)
      const snapshotDate = new Date().toISOString().slice(0, 10);
      const snapshotRows = rows.map(r => ({
        snapshot_date:  snapshotDate,
        entity:         'IN',
        invoice_id:     r.invoice_id,
        invoice_number: r.invoice_number,
        customer_name:  r.customer_name,
        invoice_date:   r.invoice_date,
        due_date:       r.due_date,
        status:         r.status,
        total:          r.total,
        balance:        r.balance,
        currency_code:  r.currency_code,
        exchange_rate:  r.exchange_rate,
        total_inr:      r.total_inr,
        balance_inr:    r.balance_inr,
      }));
      for (let i = 0; i < snapshotRows.length; i += 500) {
        const { error: snapErr } = await supabase
          .from('ar_invoice_snapshots')
          .upsert(snapshotRows.slice(i, i + 500), { onConflict: 'invoice_id,snapshot_date,entity' });
        if (snapErr) send('progress', { step: 3, total: 3, message: `Snapshot warning: ${snapErr.message}` });
      }

      send('done', { synced: rows.length, pages: page });
    } catch (e) {
      send('error', { message: String(e) });
    } finally {
      close();
    }
  })();

  return response;
});
