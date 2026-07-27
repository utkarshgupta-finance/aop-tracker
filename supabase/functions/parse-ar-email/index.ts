import * as XLSX from 'https://esm.sh/xlsx@0.18.5';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INBOUND_SECRET = Deno.env.get('PARSE_AR_SECRET') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function parseDate(val: unknown): string | null {
  if (!val || typeof val !== 'string') return null;
  const parts = val.trim().split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

interface InvoiceRow {
  invoice_id:     string;
  invoice_number: string;
  customer_name:  string;
  invoice_date:   string | null;
  due_date:       string | null;
  status:         string;
  total:          number;
  balance:        number;
  currency_code:  string;
  entity:         string;
  synced_at:      string;
}

function parseExcel(buffer: ArrayBuffer): InvoiceRow[] {
  const wb  = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

  const syncedAt = new Date().toISOString();
  const rows: InvoiceRow[] = [];

  for (let i = 5; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    const invoiceNo = String(row[1] ?? '').trim();
    if (!invoiceNo) continue;

    rows.push({
      invoice_id:     invoiceNo,
      invoice_number: invoiceNo,
      customer_name:  String(row[2] ?? '').trim(),
      invoice_date:   parseDate(row[0]),
      due_date:       parseDate(row[3]),
      status:         'open',
      total:          Number(row[4] ?? 0) || 0,
      balance:        Number(row[5] ?? 0) || 0,
      currency_code:  'GBP',
      entity:         'UK',
      synced_at:      syncedAt,
    });
  }

  return rows;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (INBOUND_SECRET) {
    const url = new URL(req.url);
    if (url.searchParams.get('secret') !== INBOUND_SECRET)
      return json({ error: 'Unauthorized' }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const attachments = (body.Attachments ?? body.attachments ?? []) as Array<Record<string, unknown>>;
  const xlsxAtt = attachments.find((a) => {
    const name = String(a.Name ?? a.name ?? '').toLowerCase();
    const ct   = String(a.ContentType ?? a.content_type ?? '').toLowerCase();
    return name.endsWith('.xlsx') || ct.includes('spreadsheetml') || ct.includes('excel');
  });

  if (!xlsxAtt)
    return json({ ok: true, skipped: true, message: 'No .xlsx attachment — nothing to process', attachments: attachments.map(a => a.Name) });

  const b64 = String(xlsxAtt.Content ?? xlsxAtt.content ?? '');
  if (!b64) return json({ ok: true, skipped: true, message: 'Attachment content is empty' });

  let buffer: ArrayBuffer;
  try {
    const clean  = b64.replace(/\s/g, '');   // strip MIME line-wrap whitespace
    const binary = atob(clean);
    buffer = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  } catch (e) {
    console.error('[parse-ar-email] base64 decode error:', e);
    return json({ error: 'Failed to decode attachment: ' + String(e) }, 500);
  }

  let rows: InvoiceRow[];
  try { rows = parseExcel(buffer); }
  catch (e) {
    console.error('[parse-ar-email] Excel parse error:', e);
    return json({ error: 'Failed to parse Excel: ' + String(e) }, 500);
  }

  if (rows.length === 0) return json({ ok: true, inserted: 0, message: 'No invoice rows found in file' });

  // Derive snapshot date from email's Date header, fall back to today
  const emailDate = typeof body.Date === 'string' ? body.Date : null;
  const snapshotDate = emailDate
    ? new Date(emailDate).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const snapshotMonth = snapshotDate.slice(0, 7); // 'YYYY-MM'

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Look up GBP/INR rate for this month
  const { data: fxRow } = await supabase
    .from('fx_rates')
    .select('rate')
    .eq('year_month', snapshotMonth)
    .eq('currency', 'GBP')
    .maybeSingle();
  const gbpRate: number = fxRow?.rate ?? null;

  // Upsert current open invoices (INR fields computed if rate is known)
  const invoiceRows = rows.map(r => ({
    ...r,
    total_inr:   gbpRate ? Math.round(r.total   * gbpRate * 100) / 100 : null,
    balance_inr: gbpRate ? Math.round(r.balance * gbpRate * 100) / 100 : null,
    exchange_rate: gbpRate ?? null,
  }));
  const { error: upsertErr } = await supabase
    .from('ar_invoices')
    .upsert(invoiceRows, { onConflict: 'invoice_id' });
  if (upsertErr) {
    console.error('[parse-ar-email] ar_invoices upsert error:', upsertErr);
    return json({ error: 'Upsert failed: ' + upsertErr.message }, 500);
  }

  // Remove UK invoices no longer in the open list
  const ids = rows.map(r => r.invoice_id);
  const { error: delErr } = await supabase
    .from('ar_invoices')
    .delete()
    .not('invoice_id', 'in', `(${ids.map(id => `"${id}"`).join(',')})`)
    .eq('entity', 'UK');
  if (delErr) console.warn('Cleanup warning:', delErr.message);

  // Write historical snapshot with INR values if rate is available
  const snapshotRows = rows.map(r => ({
    snapshot_date:  snapshotDate,
    entity:         'UK',
    invoice_id:     r.invoice_id,
    invoice_number: r.invoice_number,
    customer_name:  r.customer_name,
    invoice_date:   r.invoice_date,
    due_date:       r.due_date,
    status:         r.status,
    total:          r.total,
    balance:        r.balance,
    currency_code:  'GBP',
    exchange_rate:  gbpRate ?? null,
    total_inr:      gbpRate ? Math.round(r.total   * gbpRate * 100) / 100 : null,
    balance_inr:    gbpRate ? Math.round(r.balance * gbpRate * 100) / 100 : null,
  }));
  const { error: snapErr } = await supabase
    .from('ar_invoice_snapshots')
    .upsert(snapshotRows, { onConflict: 'invoice_id,snapshot_date,entity' });
  if (snapErr) console.warn('Snapshot insert warning:', snapErr.message);

  return json({ ok: true, inserted: rows.length, snapshot_date: snapshotDate, gbp_rate: gbpRate });
});
