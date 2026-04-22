import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PUSH_SECRET = Deno.env.get('AOP_PUSH_SECRET') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Index 0 = Mar-2026 (base), 1 = Apr-2026 … 12 = Mar-2027
const MONTH_DATES = [
  '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01',
  '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01',
  '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01',
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body: { mrr_data?: Record<string, number[]>; nrr_data?: Record<string, number[]>; secret?: string };
  try { body = await req.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  if (!PUSH_SECRET || body.secret !== PUSH_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  if (!body.mrr_data || !body.nrr_data) {
    return new Response(JSON.stringify({ error: 'Missing mrr_data or nrr_data' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Load BU and FY lookups in parallel
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
  const fyId     = fyRow.id;
  const pushedAt = new Date().toISOString();

  // Build one row per BU × month with mrr_aop + nrr_aop side by side
  const targetRows: Array<{
    bu_id: number; fy_id: number; month_date: string;
    mrr_aop: number; nrr_aop: number; pushed_at: string;
  }> = [];

  for (const buName of Object.keys(body.mrr_data)) {
    const buId = buMap[buName];
    if (!buId) continue;
    const mrrVals = body.mrr_data[buName];
    const nrrVals = body.nrr_data[buName] ?? [];
    mrrVals.forEach((mrr, i) => {
      if (MONTH_DATES[i]) {
        targetRows.push({
          bu_id: buId, fy_id: fyId, month_date: MONTH_DATES[i],
          mrr_aop: mrr, nrr_aop: nrrVals[i] ?? 0,
          pushed_at: pushedAt,
        });
      }
    });
  }

  // Write normalized rows + snapshot in parallel
  const [targetsResult, snapshotResult] = await Promise.all([
    supabase.from('aop_targets').upsert(targetRows, { onConflict: 'bu_id,fy_id,month_date' }),
    supabase.from('aop_snapshots').insert({ mrr_data: body.mrr_data, nrr_data: body.nrr_data }),
  ]);

  if (targetsResult.error) {
    return new Response(JSON.stringify({ error: 'targets: ' + targetsResult.error.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  if (snapshotResult.error) {
    return new Response(JSON.stringify({ error: 'snapshot: ' + snapshotResult.error.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({ success: true, pushed_at: pushedAt, rows_written: targetRows.length }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});
