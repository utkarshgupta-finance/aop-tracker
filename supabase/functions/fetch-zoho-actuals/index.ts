import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Zoho credentials stored as Edge Function secrets
const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')     ?? '';
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET') ?? '';
const ZOHO_REFRESH_TOKEN = Deno.env.get('ZOHO_REFRESH_TOKEN') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EXCLUDED_STAGES = new Set([
  'Closed Lost', 'No Connect', 'Lead not contacted',
  'Lead qualification in progress', 'Lead disqualified',
]);

// FY2627 months to fetch: Apr-2026 → Mar-2027
const FY_MONTHS = [
  { y: 2026, m: 4 },  { y: 2026, m: 5 },  { y: 2026, m: 6 },
  { y: 2026, m: 7 },  { y: 2026, m: 8 },  { y: 2026, m: 9 },
  { y: 2026, m: 10 }, { y: 2026, m: 11 }, { y: 2026, m: 12 },
  { y: 2027, m: 1 },  { y: 2027, m: 2 },  { y: 2027, m: 3 },
];

async function getAccessToken(): Promise<{ token: string } | { error: string }> {
  const resp = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  });
  const json = await resp.json();
  if (json.access_token) return { token: json.access_token };
  return { error: json.error ?? JSON.stringify(json) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Get Zoho access token
  const tokenResult = await getAccessToken();
  if ('error' in tokenResult) {
    return new Response(JSON.stringify({ error: 'Zoho token failed: ' + tokenResult.error }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const H = { 'Authorization': 'Zoho-oauthtoken ' + tokenResult.token };

  // Load BU and FY masters
  const [{ data: buRows }, { data: fyRow }] = await Promise.all([
    supabase.from('bu_master').select('id, name').eq('is_active', true),
    supabase.from('fy_master').select('id').eq('is_current', true).single(),
  ]);

  if (!buRows || !fyRow) {
    return new Response(JSON.stringify({ error: 'Failed to load master data' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const buMap: Record<string, number> = Object.fromEntries(buRows.map((b) => [b.name, b.id]));
  const buNames = new Set(Object.keys(buMap));
  const fyId = fyRow.id;

  // Step 1: Build dealId → buName map from BU_Deal_Map
  const dealToBU: Record<string, string> = {};
  let buPage = 1, buMore = true;
  while (buMore) {
    const r = await fetch(
      `https://www.zohoapis.in/crm/v3/BU_Deal_Map?fields=id,Deal,Business_Unit&per_page=200&page=${buPage}`,
      { headers: H },
    );
    const j = await r.json();
    for (const rec of (j.data ?? [])) {
      if (rec.Deal && rec.Business_Unit) dealToBU[rec.Deal.id] = rec.Business_Unit.name;
    }
    buMore = !!(j.info?.more_records);
    buPage++;
  }

  // Step 2: Fetch farming deals month by month (only up to current month)
  const now = new Date();
  const curY = now.getFullYear(), curM = now.getMonth() + 1;
  const rows: Array<{
    bu_id: number; fy_id: number; month_date: string;
    farming_mrr: number; snapshotted_at: string;
  }> = [];
  const snappedAt = now.toISOString();

  for (const { y, m } of FY_MONTHS) {
    if (y > curY || (y === curY && m > curM)) break;

    const mStr    = String(m).padStart(2, '0');
    const lastDay = new Date(y, m, 0).getDate();
    const dateFrom = `${y}-${mStr}-01`;
    const dateTo   = `${y}-${mStr}-${String(lastDay).padStart(2, '0')}`;

    const buTotals: Record<string, number> = {};
    for (const bn of buNames) buTotals[bn] = 0;

    const criteria = encodeURIComponent(
      `(Closing_Date:between:${dateFrom},${dateTo})and(Deal_Type_New_or_Existing:equals:Farming)`,
    );
    let page = 1, more = true;
    while (more) {
      const r = await fetch(
        `https://www.zohoapis.in/crm/v3/Deals/search?criteria=${criteria}&fields=id,Stage,Probability_Adjusted_MRR&per_page=200&page=${page}`,
        { headers: H },
      );
      const j = await r.json();
      for (const deal of (j.data ?? [])) {
        if (EXCLUDED_STAGES.has(deal.Stage)) continue;
        const buName = dealToBU[deal.id];
        if (buName && Object.prototype.hasOwnProperty.call(buTotals, buName)) {
          buTotals[buName] += deal.Probability_Adjusted_MRR ?? 0;
        }
      }
      more = !!(j.info?.more_records);
      page++;
    }

    for (const [buName, total] of Object.entries(buTotals)) {
      const buId = buMap[buName];
      if (!buId) continue;
      rows.push({ bu_id: buId, fy_id: fyId, month_date: dateFrom, farming_mrr: Math.round(total), snapshotted_at: snappedAt });
    }
  }

  const { error } = await supabase
    .from('crm_actuals')
    .upsert(rows, { onConflict: 'bu_id,fy_id,month_date' });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({ success: true, rows_written: rows.length, snapshotted_at: snappedAt }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});
