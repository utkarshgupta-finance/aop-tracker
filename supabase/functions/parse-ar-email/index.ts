import * as XLSX from 'https://esm.sh/xlsx@0.18.5';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INBOUND_SECRET = Deno.env.get('PARSE_AR_SECRET') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Parse "DD/MM/YYYY" → "YYYY-MM-DD" (or null if invalid)
function parseDate(val: unknown): string | null {
  if (!val || typeof val !== 'string') return null;
  const parts = val.trim().split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

interface InvoiceRow {
  invoice_id: string;
  invoice_number: string;
  customer_name: string;
  invoice_date: string | null;
  due_date: string | null;
  status: string;
  total: number;
  balance: number;
  currency_code: string;
  entity: string | null;
  synced_at: string;
}

function parseExcel(buffer: ArrayBuffer): { rows: InvoiceRow[]; entity: string | null } {
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Row 1 = entity name, Row 4 = headers, Row 5+ = data
  const entity = typeof raw[1]?.[0] === 'string' ? (raw[1][0] as string).trim() : null;
  const syncedAt = new Date().toISOString();
  const rows: InvoiceRow[] = [];

  for (let i = 5; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    // Skip empty or footer rows (no invoice number)
    const invoiceNo = String(row[1] ?? '').trim();
    if (!invoiceNo) continue;

    const total   = Number(row[4] ?? 0) || 0;
    const balance = Number(row[5] ?? 0) || 0;

    rows.push({
      invoice_id:     invoiceNo,
      invoice_number: invoiceNo,
      customer_name:  String(row[2] ?? '').trim(),
      invoice_date:   parseDate(row[0]),
      due_date:       parseDate(row[3]),
      status:         'open',
      total,
      balance,
      currency_code:  'GBP',
      entity:         'UK',
      synced_at:      syncedAt,
    });
  }

  return { rows, entity };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Validate secret token if configured
  if (INBOUND_SECRET) {
    const url = new URL(req.url);
    if (url.searchParams.get('secret') !== INBOUND_SECRET)
      return json({ error: 'Unauthorized' }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Find xlsx attachment from Postmark inbound payload
  const attachments = (body.Attachments ?? body.attachments ?? []) as Array<Record<string, unknown>>;
  const xlsxAtt = attachments.find((a) => {
    const name = String(a.Name ?? a.name ?? '').toLowerCase();
    const ct   = String(a.ContentType ?? a.content_type ?? '').toLowerCase();
    return name.endsWith('.xlsx') || ct.includes('spreadsheetml') || ct.includes('excel');
  });

  // Always acknowledge receipt — no .xlsx just means nothing to process
  if (!xlsxAtt) {
    return json({ ok: true, skipped: true, message: 'No .xlsx attachment — nothing to process', attachments: attachments.map(a => a.Name) });
  }

  const b64 = String(xlsxAtt.Content ?? xlsxAtt.content ?? '');
  if (!b64) return json({ ok: true, skipped: true, message: 'Attachment content is empty' });

  // Decode base64 → ArrayBuffer
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view   = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);

  let rows: InvoiceRow[];
  let entity: string | null;
  try {
    ({ rows, entity } = parseExcel(buffer));
  } catch (e) {
    return json({ error: 'Failed to parse Excel: ' + String(e) }, 500);
  }

  if (rows.length === 0) return json({ ok: true, inserted: 0, message: 'No invoice rows found in file' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Upsert all rows from this snapshot
  const { error: upsertErr } = await supabase
    .from('ar_invoices')
    .upsert(rows, { onConflict: 'invoice_id' });

  if (upsertErr) return json({ error: 'Upsert failed: ' + upsertErr.message }, 500);

  // Remove invoices no longer in the open list (they've been paid/closed)
  const ids = rows.map(r => r.invoice_id);
  const { error: delErr } = await supabase
    .from('ar_invoices')
    .delete()
    .not('invoice_id', 'in', `(${ids.map(id => `"${id}"`).join(',')})`)
    .eq('currency_code', 'GBP'); // only clean up QB/GBP rows, leave Zoho rows untouched

  if (delErr) console.warn('Cleanup warning:', delErr.message);

  return json({ ok: true, inserted: rows.length, entity });
});
