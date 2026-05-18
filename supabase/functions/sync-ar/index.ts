import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')     ?? '';
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET') ?? '';
const ZOHO_REFRESH_TOKEN = Deno.env.get('ZOHO_REFRESH_TOKEN') ?? '';
const BOOKS_ORG_ID       = '60001574931';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function getAccessToken(): Promise<{ token: string } | { error: string }> {
  const resp = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET, refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  });
  const j = await resp.json();
  if (j.access_token) return { token: j.access_token };
  return { error: j.error ?? JSON.stringify(j) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const tok = await getAccessToken();
  if ('error' in tok) return json({ error: 'Zoho auth failed: ' + tok.error }, 500);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // Fetch all pages of open (unpaid) invoices from Zoho Books
  type InvRow = Record<string, unknown>;
  const rows: InvRow[] = [];
  const syncedAt = new Date().toISOString();
  let page = 1;

  while (true) {
    const url = `https://www.zohoapis.in/books/v3/invoices?organization_id=${BOOKS_ORG_ID}&filter_by=Status.Unpaid&per_page=200&page=${page}&sort_column=due_date`;
    const resp = await fetch(url, { headers: { Authorization: 'Zoho-oauthtoken ' + tok.token } });
    const data = await resp.json();
    if (!resp.ok || data.code !== 0) {
      return json({ error: data.message ?? 'Zoho Books API error', code: data.code }, 500);
    }
    for (const inv of data.invoices ?? []) {
      rows.push({
        invoice_id:      inv.invoice_id,
        invoice_number:  inv.invoice_number,
        customer_name:   inv.customer_name,
        invoice_date:    inv.date     || null,
        due_date:        inv.due_date || null,
        status:          inv.status,
        total:           Number(inv.total   ?? 0),
        balance:         Number(inv.balance ?? 0),
        revenue_type:    inv.cf_revenue_type      || null,
        service_from:    inv.cf_new_service_from  || null,
        service_to:      inv.cf_new_service_to    || null,
        reference_number: inv.reference_number    || null,
        salesperson_name: inv.salesperson_name    || null,
        synced_at:       syncedAt,
      });
    }
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  // Replace all — clear stale rows then insert fresh
  await supabase.from('ar_invoices').delete().neq('invoice_id', '');
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('ar_invoices').insert(rows.slice(i, i + 500));
    if (error) return json({ error: 'Insert failed: ' + error.message }, 500);
  }
  return json({ ok: true, synced: rows.length, pages: page });
});
