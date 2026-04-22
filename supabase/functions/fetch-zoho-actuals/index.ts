import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')     ?? '';
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET') ?? '';
const ZOHO_REFRESH_TOKEN = Deno.env.get('ZOHO_REFRESH_TOKEN') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EXCLUDED_STAGES = new Set([
  'Closed Lost', 'No Connect', 'Lead not contacted',
  'Lead qualification in progress', 'Lead disqualified', 'Project Kept on Hold',
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

  // ?raw=1 — return first COQL response verbatim for debugging
  const url = new URL(req.url);
  if (url.searchParams.get('raw') === '1') {
    const tok = await getAccessToken();
    if ('error' in tok) return new Response(JSON.stringify(tok), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    const r = await fetch('https://www.zohoapis.in/crm/v3/coql', {
      method: 'POST',
      headers: { 'Authorization': 'Zoho-oauthtoken ' + tok.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ select_query: "SELECT Business_Unit, Deal.Stage, Deal.Probability_Adjusted_MRR FROM BU_Deal_Map WHERE Deal.Closing_Date between '2026-04-01' and '2026-04-30' AND Deal.Deal_Type_New_or_Existing = 'Farming' AND Deal.Probability_Adjusted_MRR > 0 LIMIT 3 OFFSET 0" }),
    });
    const raw = await r.text();
    return new Response(raw, { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const tokenResult = await getAccessToken();
  if ('error' in tokenResult) {
    return new Response(JSON.stringify({ error: 'Zoho token failed: ' + tokenResult.error }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const H = {
    'Authorization': 'Zoho-oauthtoken ' + tokenResult.token,
    'Content-Type': 'application/json',
  };

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

  // Build Zoho BU record ID → BU name map (COQL returns only IDs for lookup fields)
  // Regular REST API returns Business_Unit with both name and id
  const zohoIdToBuName: Record<string, string> = {};
  {
    let pg = 1, morePages = true;
    while (morePages && Object.keys(zohoIdToBuName).length < buNames.size) {
      const r = await fetch(
        `https://www.zohoapis.in/crm/v3/BU_Deal_Map?fields=Business_Unit&per_page=200&page=${pg}`,
        { headers: { 'Authorization': 'Zoho-oauthtoken ' + tokenResult.token } },
      );
      const j = await r.json();
      for (const rec of (j.data ?? [])) {
        const bu = rec.Business_Unit;
        if (bu?.id && bu?.name) zohoIdToBuName[bu.id] = bu.name;
      }
      morePages = !!(j.info?.more_records);
      pg++;
    }
  }

  const now = new Date();
  const curY = now.getFullYear(), curM = now.getMonth() + 1;
  const snappedAt = now.toISOString();

  const rows: Array<{
    bu_id: number; fy_id: number; month_date: string;
    farming_mrr: number; snapshotted_at: string;
  }> = [];
  let debugSample: unknown = null;

  for (const { y, m } of FY_MONTHS) {
    if (y > curY || (y === curY && m > curM)) break;

    const mStr    = String(m).padStart(2, '0');
    const lastDay = new Date(y, m, 0).getDate();
    const dateFrom = `${y}-${mStr}-01`;
    const dateTo   = `${y}-${mStr}-${String(lastDay).padStart(2, '0')}`;

    const buTotals: Record<string, number> = {};
    for (const bn of buNames) buTotals[bn] = 0;

    // Query BU_Deal_Map via COQL — one row per deal-BU pair, matching Zoho analytics behaviour
    let offset = 0, more = true;
    while (more) {
      const r = await fetch('https://www.zohoapis.in/crm/v3/coql', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          select_query: `SELECT Business_Unit, Deal.Stage, Deal.Probability_Adjusted_MRR FROM BU_Deal_Map WHERE Deal.Closing_Date between '${dateFrom}' and '${dateTo}' AND Deal.Deal_Type_New_or_Existing = 'Farming' AND Deal.Probability_Adjusted_MRR > 0 LIMIT 200 OFFSET ${offset}`,
        }),
      });
      const j = await r.json();

      if (!debugSample && j.data?.[0]) debugSample = j.data[0];

      for (const rec of (j.data ?? [])) {
        // support both flat dot-notation keys and nested Deal object
        const stage = rec['Deal.Stage'] ?? rec.Deal?.Stage ?? '';
        const mrr   = rec['Deal.Probability_Adjusted_MRR'] ?? rec.Deal?.Probability_Adjusted_MRR ?? 0;
        if (EXCLUDED_STAGES.has(stage)) continue;
        const buName = zohoIdToBuName[rec.Business_Unit?.id];
        if (buName && buNames.has(buName)) {
          buTotals[buName] += mrr;
        }
      }

      more = !!(j.info?.more_records);
      offset += 200;
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
    JSON.stringify({ success: true, rows_written: rows.length, snapshotted_at: snappedAt, debug_sample: debugSample }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});
