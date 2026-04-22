const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')     ?? '';
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET') ?? '';
const ZOHO_REFRESH_TOKEN = Deno.env.get('ZOHO_REFRESH_TOKEN') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const INCLUDED_STAGES = new Set([
  'Initial discussion', 'Demo', 'Decision maker bought in', 'Decision Maker Bought-In',
  'Proposal Out', 'Revised Pricing', 'Negotiation', 'Differed timeline',
  'PO pending', 'Closed Won', 'MRR Live',
]);

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

  const url    = new URL(req.url);
  const buName = url.searchParams.get('bu_name') ?? '';
  const month  = url.searchParams.get('month')   ?? '';

  if (!buName || !month) {
    return new Response(JSON.stringify({ error: 'Missing bu_name or month param' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const [yearStr, monStr] = month.split('-');
  const y = parseInt(yearStr, 10), m = parseInt(monStr, 10);
  if (!y || !m || m < 1 || m > 12) {
    return new Response(JSON.stringify({ error: 'Invalid month format — use YYYY-MM' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const tokenResult = await getAccessToken();
  if ('error' in tokenResult) {
    return new Response(JSON.stringify({ error: 'Zoho token failed: ' + tokenResult.error }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const authHeader = 'Zoho-oauthtoken ' + tokenResult.token;
  const H = { 'Authorization': authHeader, 'Content-Type': 'application/json' };

  // Pre-fetch all BU_Deal_Map pages to build Zoho record ID → BU name map
  const zohoIdToBuName: Record<string, string> = {};
  {
    let pg = 1, morePages = true;
    while (morePages) {
      const r = await fetch(
        `https://www.zohoapis.in/crm/v3/BU_Deal_Map?fields=Business_Unit&per_page=200&page=${pg}`,
        { headers: { 'Authorization': authHeader } },
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

  const mStr    = String(m).padStart(2, '0');
  const lastDay = new Date(y, m, 0).getDate();
  const dateFrom = `${y}-${mStr}-01`;
  const dateTo   = `${y}-${mStr}-${String(lastDay).padStart(2, '0')}`;

  const deals: Array<{
    deal_name: string;
    business_unit: string;
    adjusted_mrr: number;
    expected_mrr: number;
    probability: number;
    region: string;
    stage: string;
  }> = [];

  let offset = 0, more = true;
  while (more) {
    const r = await fetch('https://www.zohoapis.in/crm/v3/coql', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        select_query: `SELECT Business_Unit, Deal.Deal_Name, Deal.Stage, Deal.Probability_Adjusted_MRR, Deal.Probability, Deal.Region FROM BU_Deal_Map WHERE Deal.Closing_Date between '${dateFrom}' and '${dateTo}' AND Deal.Deal_Type_New_or_Existing = 'Farming' LIMIT 200 OFFSET ${offset}`,
      }),
    });
    const j = await r.json();

    for (const rec of (j.data ?? [])) {
      const stage       = rec['Deal.Stage']  ?? rec.Deal?.Stage  ?? '';
      const probability = rec['Deal.Probability'] ?? rec.Deal?.Probability ?? 0;
      if (!INCLUDED_STAGES.has(stage)) continue;
      if (probability < 70) continue;

      const recBuName = zohoIdToBuName[rec.Business_Unit?.id];
      if (recBuName !== buName) continue;

      const adjustedMRR = rec['Deal.Probability_Adjusted_MRR'] ?? rec.Deal?.Probability_Adjusted_MRR ?? 0;
      const expectedMRR = probability > 0 ? Math.round(adjustedMRR / (probability / 100)) : adjustedMRR;

      deals.push({
        deal_name:     rec['Deal.Deal_Name'] ?? rec.Deal?.Deal_Name ?? '',
        business_unit: recBuName,
        adjusted_mrr:  Math.round(adjustedMRR),
        expected_mrr:  expectedMRR,
        probability,
        region:        rec['Deal.Region'] ?? rec.Deal?.Region ?? '',
        stage,
      });
    }

    more = !!(j.info?.more_records);
    offset += 200;
  }

  return new Response(
    JSON.stringify({ deals }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});
