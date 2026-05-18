import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const QBO_CLIENT_ID     = Deno.env.get('QBO_CLIENT_ID')     ?? '';
const QBO_CLIENT_SECRET = Deno.env.get('QBO_CLIENT_SECRET') ?? '';
const QBO_REFRESH_TOKEN = Deno.env.get('QBO_REFRESH_TOKEN') ?? '';
const QBO_REALM_ID      = Deno.env.get('QBO_REALM_ID')      ?? '';

// Exchange rate: GBP → INR (updated each sync from a free API)
const FALLBACK_GBP_INR = 107; // approximate fallback

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function getQBOAccessToken(): Promise<{ token: string } | { error: string; detail: unknown }> {
  if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET || !QBO_REFRESH_TOKEN) {
    return { error: 'qbo_not_configured', detail: 'QBO_CLIENT_ID, QBO_CLIENT_SECRET, and QBO_REFRESH_TOKEN must be set as Supabase secrets' };
  }
  const creds = btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`);
  const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: QBO_REFRESH_TOKEN }),
  });
  const j = await resp.json();
  if (j.access_token) return { token: j.access_token };
  return { error: j.error ?? 'token_error', detail: j };
}

async function getGBPtoINR(): Promise<number> {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/GBP');
    const d = await r.json();
    return d?.rates?.INR ?? FALLBACK_GBP_INR;
  } catch {
    return FALLBACK_GBP_INR;
  }
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);

  if (url.searchParams.get('test') === '1') {
    const tok = await getQBOAccessToken();
    if ('error' in tok) return json({ stage: 'auth', ...tok }, 500);
    const r = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${QBO_REALM_ID}/query?query=SELECT%20*%20FROM%20Invoice%20WHERE%20Balance%20%3E%20'0'%20MAXRESULTS%205&minorversion=65`,
      { headers: { Authorization: `Bearer ${tok.token}`, Accept: 'application/json' } }
    );
    const data = await r.json();
    return json({ stage: 'qbo_api', http_status: r.status, fault: data.Fault, count: data.QueryResponse?.Invoice?.length, sample: data.QueryResponse?.Invoice?.slice(0, 1) });
  }

  const { response, send, close } = sseStream();

  (async () => {
    try {
      send('progress', { step: 1, total: 3, message: 'Authenticating with QuickBooks…' });
      const tok = await getQBOAccessToken();
      if ('error' in tok) {
        send('error', { message: `QBO auth failed: ${tok.error}`, detail: tok.detail });
        close(); return;
      }
      if (!QBO_REALM_ID) {
        send('error', { message: 'QBO_REALM_ID secret is not set' });
        close(); return;
      }

      send('progress', { step: 2, total: 3, message: 'Fetching open invoices from QuickBooks…' });

      // Fetch GBP→INR rate once per sync
      const gbpToINR = await getGBPtoINR();

      type InvRow = Record<string, unknown>;
      const rows: InvRow[] = [];
      const syncedAt = new Date().toISOString();
      let startPos = 1;
      const pageSize = 1000;

      while (true) {
        const query = encodeURIComponent(`SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`);
        const apiUrl = `https://quickbooks.api.intuit.com/v3/company/${QBO_REALM_ID}/query?query=${query}&minorversion=65`;
        const resp = await fetch(apiUrl, { headers: { Authorization: `Bearer ${tok.token}`, Accept: 'application/json' } });
        const data = await resp.json();
        if (!resp.ok || data.Fault) {
          send('error', { message: data.Fault?.Error?.[0]?.Message ?? 'QBO API error', http_status: resp.status });
          close(); return;
        }

        const invoices: Record<string, unknown>[] = data.QueryResponse?.Invoice ?? [];
        for (const inv of invoices) {
          const currencyCode = (inv.CurrencyRef as Record<string,unknown>)?.value as string || 'GBP';
          const exchangeRate = currencyCode === 'GBP' ? gbpToINR : Number((inv as Record<string,unknown>).ExchangeRate ?? 1) || 1;
          const total   = Number(inv.TotalAmt  ?? 0);
          const balance = Number(inv.Balance   ?? 0);
          const custRef = inv.CustomerRef as Record<string,unknown>;
          const txnDate = inv.TxnDate as string || null;
          const dueDate = inv.DueDate as string || null;
          const invId   = inv.Id as string;
          rows.push({
            invoice_id:       `qb_${invId}`,
            invoice_number:   inv.DocNumber ?? invId,
            customer_name:    custRef?.name ?? 'Unknown',
            invoice_date:     txnDate,
            due_date:         dueDate,
            status:           balance < total ? 'partially_paid' : 'sent',
            entity:           'UK',
            currency_code:    currencyCode,
            exchange_rate:    exchangeRate,
            total:            total,
            balance:          balance,
            total_inr:        Math.round(total   * exchangeRate * 100) / 100,
            balance_inr:      Math.round(balance * exchangeRate * 100) / 100,
            revenue_type:     null,
            service_from:     null,
            service_to:       null,
            reference_number: null,
            salesperson_name: null,
            invoice_url:      `https://app.qbo.intuit.com/app/invoice?txnId=${invId}`,
            synced_at:        syncedAt,
          });
        }

        send('progress', { step: 2, total: 3, message: `Fetched ${rows.length} invoices so far…` });
        if (invoices.length < pageSize) break;
        startPos += pageSize;
      }

      send('progress', { step: 3, total: 3, message: `Saving ${rows.length} invoices to database…` });
      const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase
          .from('ar_invoices')
          .upsert(rows.slice(i, i + 500), { onConflict: 'invoice_id' });
        if (error) { send('error', { message: 'Upsert failed: ' + error.message }); close(); return; }
      }

      // Remove UK invoices that are no longer open
      if (rows.length > 0) {
        const ids = rows.map(r => r.invoice_id as string);
        const { error: delErr } = await supabase
          .from('ar_invoices')
          .delete()
          .eq('entity', 'UK')
          .not('invoice_id', 'in', `(${ids.map(id => `"${id}"`).join(',')})`);
        if (delErr) {
          send('progress', { step: 3, total: 3, message: `Note: cleanup failed: ${delErr.message}` });
        }
      }

      send('done', { synced: rows.length });
    } catch (e) {
      send('error', { message: String(e) });
    } finally {
      close();
    }
  })();

  return response;
});
