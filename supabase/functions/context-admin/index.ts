const ADMIN_PASSWORD = Deno.env.get('CONTEXT_ADMIN_PASSWORD') ?? '';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

  let body: {
    password?: string;
    operation?: string;
    content?: string;
    change_note?: string;
    version_id?: number;
  };
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.password || body.password !== ADMIN_PASSWORD)
    return json({ error: 'Unauthorized' }, 401);

  const sbHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  // ── save_version ──────────────────────────────────────────────────────────
  if (body.operation === 'save_version') {
    if (!body.content?.trim()) return json({ error: 'content required' }, 400);

    const vR = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_context?select=version&order=version.desc&limit=1`,
      { headers: sbHeaders }
    );
    const vRows = await vR.json();
    const nextVersion = ((vRows[0]?.version) ?? 0) + 1;

    await fetch(
      `${SUPABASE_URL}/rest/v1/ai_context?is_active=eq.true`,
      { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ is_active: false }) }
    );

    const iR = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_context`,
      {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          version: nextVersion,
          content: body.content,
          updated_by: 'saleem',
          updated_at: new Date().toISOString(),
          change_note: body.change_note || '',
          is_active: true,
        }),
      }
    );
    const inserted = await iR.json();
    if (!iR.ok) return json({ error: inserted }, 500);
    return json({ ok: true, version: nextVersion, id: inserted[0]?.id });
  }

  // ── rollback ──────────────────────────────────────────────────────────────
  if (body.operation === 'rollback') {
    if (!body.version_id) return json({ error: 'version_id required' }, 400);

    await fetch(
      `${SUPABASE_URL}/rest/v1/ai_context?is_active=eq.true`,
      { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ is_active: false }) }
    );
    const rR = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_context?id=eq.${body.version_id}`,
      { method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ is_active: true }) }
    );
    if (!rR.ok) return json({ error: await rR.json() }, 500);
    return json({ ok: true, rolled_back_to: body.version_id });
  }

  // ── list_versions ─────────────────────────────────────────────────────────
  if (body.operation === 'list_versions') {
    const lR = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_context?select=id,version,updated_by,updated_at,change_note,is_active&order=version.desc`,
      { headers: sbHeaders }
    );
    const rows = await lR.json();
    if (!lR.ok) return json({ error: rows }, 500);
    return json({ ok: true, versions: rows });
  }

  return json({ error: 'Unknown operation' }, 400);
});
