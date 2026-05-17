const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function fetchActiveContext(supaUrl: string, supaKey: string): Promise<string> {
  try {
    const r = await fetch(
      `${supaUrl}/rest/v1/ai_context?is_active=eq.true&select=content&limit=1`,
      { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
    );
    const rows = await r.json();
    return rows?.[0]?.content ?? '';
  } catch {
    return '';
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Tool: PostgREST query against Supabase (anon key — same as browser access)
const TOOLS = [
  {
    name: 'query_database',
    description: `Query the Bizom Supabase database via PostgREST REST API. Returns a JSON array of rows.

Available tables/views:
  customer_mrr_unified  — zoho_name TEXT, month_date DATE, mrr_amount NUMERIC  [merged per-customer MRR]
  bu_mrr_monthly        — bu_name TEXT, month_date DATE, mrr_amount NUMERIC     [pre-aggregated BU totals, contract+module]
  customer_mrr_lines    — zoho_name TEXT, go_live_date DATE, churn_date DATE, segment_id INT, bu_id INT
  customer_module_lines — zoho_name TEXT, services TEXT, workflow TEXT, service_type TEXT, status TEXT, billing_cycle TEXT
  aop_targets           — bu_id INT, fy_id INT, month_date DATE, mrr_aop NUMERIC, nrr_aop NUMERIC
  deal_snapshots        — snapshot_date DATE, deal_name TEXT, account_name TEXT, closing_month DATE, stage TEXT, probability SMALLINT, adjusted_mrr INT, expected_mrr INT, bu_id INT
  segment_master        — id INT, name TEXT
  bu_master             — id INT, name TEXT, code TEXT

PostgREST param syntax:
  Columns:  select=col1,col2
  Joins:    select=col,rel_table!left(col)  e.g. select=zoho_name,segment_master!left(name),bu_master!left(name)
  Filters:  col=eq.value | col=ilike.*keyword* | col=gte.YYYY-MM-01 | col=lte.val | col=not.is.null
  Sort:     order=col.desc
  Limit:    limit=N  (max 3000 — always include limit)
  Combine:  & between params

Quick examples:
  Latest month:   select=month_date&order=month_date.desc&limit=1
  Month snapshot: select=zoho_name,mrr_amount&month_date=eq.2026-03-01&limit=2000
  BU trend:       select=bu_name,month_date,mrr_amount&order=month_date&limit=2000
  One BU:         select=month_date,mrr_amount&bu_name=eq.SME BU&order=month_date&limit=500
  Segment join:   select=zoho_name,segment_master!left(name),bu_master!left(name)&limit=2000
  Customer ilike: select=zoho_name,mrr_amount&zoho_name=ilike.*glaxo*&limit=100`,
    input_schema: {
      type: 'object',
      properties: {
        table:  { type: 'string', description: 'Table or view name, e.g. customer_mrr_unified' },
        params: { type: 'string', description: 'URL query string, e.g. select=zoho_name,mrr_amount&month_date=eq.2026-03-01&limit=2000' },
      },
      required: ['table', 'params'],
    },
  },
];

async function execTool(name: string, input: Record<string, string>, supaUrl: string, supaKey: string): Promise<string> {
  if (name !== 'query_database') return JSON.stringify({ error: 'Unknown tool: ' + name });
  try {
    const url = `${supaUrl}/rest/v1/${encodeURIComponent(input.table)}?${input.params}`;
    const r = await fetch(url, {
      headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, Accept: 'application/json' },
    });
    const data = await r.json();
    if (!r.ok) return JSON.stringify({ error: data });
    const rows = Array.isArray(data) ? data.slice(0, 3000) : data;
    const note = Array.isArray(data) && data.length >= 3000 ? '\n[NOTE: Results truncated at 3000 rows — use tighter date filters if needed]' : '';
    return JSON.stringify(rows) + note;
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY secret not set in Supabase dashboard' }, 500);

  let body: { system?: string; messages?: { role: string; content: unknown }[]; supabaseUrl?: string; supabaseKey?: string };
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { system, messages, supabaseUrl = '', supabaseKey = '' } = body;
  if (!messages?.length) return json({ error: 'Missing messages' }, 400);

  const liveContext = await fetchActiveContext(supabaseUrl, supabaseKey);
  const systemBlocks = system
    ? [
        ...(liveContext ? [{
          type: 'text',
          text: `# BIZOM LIVE CONTEXT DOCUMENT\nThis document contains current business rules, definitions, and known data issues. It overrides any conflicting information in the instructions below.\n\n${liveContext}`,
          cache_control: { type: 'ephemeral' },
        }] : []),
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ]
    : undefined;

  const msgs: { role: string; content: unknown }[] = [...messages];

  // Agentic tool-use loop — up to 4 tool-call rounds, then force conclusion by stripping tools
  const MAX_TOOL_ROUNDS = 4;
  for (let iter = 0; iter <= MAX_TOOL_ROUNDS; iter++) {
    // On the final iteration, strip tools so Claude MUST write a text response
    const isLastChance = iter === MAX_TOOL_ROUNDS;
    const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        ...(systemBlocks ? { system: systemBlocks } : {}),
        ...(isLastChance ? {} : { tools: TOOLS }),
        messages: msgs,  // never append an extra user turn — would create consecutive user roles (400)
      }),
    });

    const apiData = await apiResp.json();
    if (!apiResp.ok) return new Response(JSON.stringify(apiData), { status: apiResp.status, headers: { ...CORS, 'Content-Type': 'application/json' } });

    // Final answer — end_turn or max_tokens both carry usable content
    if (apiData.stop_reason === 'end_turn' || apiData.stop_reason === 'max_tokens') {
      return json(apiData);
    }

    // Tool call(s) — execute and continue
    if (apiData.stop_reason === 'tool_use') {
      msgs.push({ role: 'assistant', content: apiData.content });
      const results = [];
      for (const block of apiData.content as { type: string; id: string; name: string; input: Record<string, string> }[]) {
        if (block.type === 'tool_use') {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: await execTool(block.name, block.input, supabaseUrl, supabaseKey),
          });
        }
      }
      msgs.push({ role: 'user', content: results });
      continue;
    }

    break; // unexpected stop reason
  }

  return json({ error: 'Agent did not produce a final response' }, 500);
});
