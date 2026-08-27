// Works out HOW each recorded closure actually settled, and corrects the row.
//
// capture-closures records that an invoice left the open book; it cannot tell
// cash from a credit note, because credits_applied and credits_associated only
// exist on Zoho's single-invoice GET, never on the list endpoint. Counting a
// credit note as a payment would overstate collections and make a broken
// promise look kept, so this fills that in with one detail call per closure.
//
// Deliberately separate from capture-closures: that function is the one that
// must never fail, and this is best-effort enrichment that can be re-run.
// Idempotent — it only looks at rows whose settlement is still unknown.

const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')            ?? '';
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET')        ?? '';
const ZOHO_REFRESH_TOKEN = Deno.env.get('ZOHO_BOOKS_REFRESH_TOKEN')
                        ?? Deno.env.get('ZOHO_REFRESH_TOKEN')         ?? '';
const BOOKS_ORG_ID = '60001574931';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const sbHdr = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

async function getAccessToken() {
  const r = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET, refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  });
  const j = await r.json();
  return j.access_token ? { token: j.access_token as string } : { error: j.error ?? 'token_error' };
}

// Whichever settled the most decides how the closure reads.
function classify(credits: number, paid: number, wo: number) {
  if (credits <= 0 && paid <= 0 && wo <= 0) return 'left_unpaid_book';
  if (wo >= credits && wo >= paid) return 'zoho_write_off';
  if (credits > paid) return 'closed_by_cn';
  return 'zoho_paid';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 120) || 120, 400);
  const dry   = url.searchParams.get('dry') === '1';
  // ?force=1&after=<invoice_id> — re-ask Zoho about rows already classified,
  // for when the reading of Zoho's answer itself changes. Paged by invoice_id
  // because there is no "stale" flag to consume.
  const force = url.searchParams.get('force') === '1';
  const after = url.searchParams.get('after') ?? '';

  try {
    const tok = await getAccessToken();
    if ('error' in tok) return json({ ok: false, stage: 'auth', ...tok }, 500);

    // Rows we have not yet asked Zoho about. IN only — the UK path has no API.
    const scope = force
      ? (after ? `&invoice_id=gt.${encodeURIComponent(after)}` : '')
      : '&credits_applied=is.null';
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/invoice_closures?entity=eq.IN${scope}`
      + `&select=invoice_id,invoice_number,closure_basis,closed_on&order=invoice_id&limit=${limit}`,
      { headers: sbHdr });
    if (!r.ok) return json({ ok: false, stage: 'read', error: await r.text() }, 500);
    const pending = await r.json();
    if (!pending.length) return json({ ok: true, pending: 0, updated: 0, message: 'Nothing left to classify.' });

    const changes: any[] = [];
    let reclassified = 0;
    for (const row of pending) {
      const ir = await fetch(
        `https://www.zohoapis.in/books/v3/invoices/${row.invoice_id}?organization_id=${BOOKS_ORG_ID}`,
        { headers: { Authorization: 'Zoho-oauthtoken ' + tok.token } });
      const d = await ir.json().catch(() => ({}));
      if (!ir.ok || d.code !== 0 || !d.invoice) continue;   // invoice gone from Zoho; leave the row alone
      const inv = d.invoice;

      const credits = Number(inv.credits_applied ?? 0);
      const paid    = Number(inv.payment_made ?? 0);
      const wo      = Number(inv.write_off_amount ?? 0);
      // Zoho reports these in the invoice's own currency. Classification only
      // compares them with each other so it is unaffected, but the stored
      // figures sit beside *_inr columns and get summed — an IDR invoice would
      // otherwise read as crores. Store INR; keep the comparison as-is.
      const rate = Number(inv.exchange_rate ?? 1) || 1;
      const inr  = (v: number) => Math.round(v * rate * 100) / 100;
      const assoc: any[] = Array.isArray(inv.credits_associated) ? inv.credits_associated : [];
      // Zoho names these creditnotes_* on the invoice detail — not the
      // creditnote_* of the credit-note endpoint. Both spellings read here so a
      // field rename upstream degrades to a missing number, not a wrong one.
      const cnNums  = assoc.map(c => c.creditnotes_number ?? c.creditnote_number ?? '').filter(Boolean);
      const cnDates = assoc.map(c => c.creditnotes_date ?? c.date ?? '').filter(Boolean).sort();

      const basis = classify(credits, paid, wo);
      if (basis !== row.closure_basis) reclassified++;
      changes.push({
        invoice_id: row.invoice_id,
        was: row.closure_basis, now: basis,
        patch: {
          closure_basis:    basis,
          credits_applied:  inr(credits),
          payment_made:     inr(paid),
          write_off_amount: inr(wo),
          amount_paid:      inr(paid),
          cn_numbers:       cnNums.length ? cnNums.join(', ') : null,
          cn_date:          cnDates.length ? cnDates[0] : null,
          // A credit-note closure is dated by the credit note; there was no
          // payment to date it by.
          closed_on: (basis === 'closed_by_cn' && cnDates.length ? cnDates[0] : null)
                     || inv.last_payment_date || row.closed_on,
          updated_at: new Date().toISOString(),
        },
      });
    }

    if (dry) {
      return json({ ok: true, dry_run: true, pending: pending.length, would_update: changes.length,
        would_reclassify: reclassified,
        by_new_basis: changes.reduce((a: any, c) => (a[c.now] = (a[c.now] ?? 0) + 1, a), {}),
        sample: changes.slice(0, 5).map(c => ({ inv: c.invoice_id, was: c.was, now: c.now, cn: c.patch.cn_numbers })) });
    }

    let updated = 0;
    for (const c of changes) {
      const ur = await fetch(
        `${SUPABASE_URL}/rest/v1/invoice_closures?invoice_id=eq.${encodeURIComponent(c.invoice_id)}`,
        { method: 'PATCH', headers: { ...sbHdr, Prefer: 'return=minimal' }, body: JSON.stringify(c.patch) });
      if (ur.ok) updated++;
    }
    return json({ ok: true, pending: pending.length, updated, reclassified,
      next_after: pending[pending.length - 1]?.invoice_id ?? null,
      by_new_basis: changes.reduce((a: any, c) => (a[c.now] = (a[c.now] ?? 0) + 1, a), {}) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
