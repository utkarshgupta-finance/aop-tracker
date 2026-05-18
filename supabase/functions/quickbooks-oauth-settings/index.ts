const ADMIN_PASSWORD = Deno.env.get('CONTEXT_ADMIN_PASSWORD') ?? '';
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const QB_AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const QB_SCOPE     = 'com.intuit.quickbooks.accounting';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const sbH = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

function randomState(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getRow(): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/integration_settings?id=eq.quickbooks&limit=1`, { headers: sbH });
  const rows = await r.json();
  return rows?.[0] ?? null;
}

async function upsert(patch: Record<string, unknown>) {
  patch.id = 'quickbooks';
  patch.updated_at = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/integration_settings`, {
    method: 'POST',
    headers: { ...sbH, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(patch),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.password || body.password !== ADMIN_PASSWORD)
    return json({ error: 'Unauthorized' }, 401);

  // ── get_status ────────────────────────────────────────────────
  if (body.operation === 'get_status') {
    const row = await getRow();
    if (!row) return json({ ok: true, status: 'disconnected', client_id: null, realm_id: null, connected_at: null });
    return json({
      ok: true,
      status:       row.status,
      client_id:    row.client_id,
      realm_id:     row.realm_id,
      connected_at: row.connected_at,
      error_message: row.error_message,
    });
  }

  // ── save_credentials ──────────────────────────────────────────
  if (body.operation === 'save_credentials') {
    const { client_id, client_secret } = body as Record<string, string>;
    if (!client_id?.trim() || !client_secret?.trim())
      return json({ error: 'client_id and client_secret required' }, 400);
    await upsert({ client_id: client_id.trim(), client_secret: client_secret.trim() });
    return json({ ok: true });
  }

  // ── get_auth_url ──────────────────────────────────────────────
  if (body.operation === 'get_auth_url') {
    const { redirect_uri } = body as Record<string, string>;
    if (!redirect_uri) return json({ error: 'redirect_uri required' }, 400);
    const row = await getRow();
    if (!row?.client_id) return json({ error: 'Save credentials first' }, 400);
    const state = randomState();
    await upsert({ oauth_state: state });
    const params = new URLSearchParams({
      client_id:     row.client_id as string,
      response_type: 'code',
      scope:         QB_SCOPE,
      redirect_uri,
      state,
    });
    return json({ ok: true, auth_url: `${QB_AUTH_URL}?${params}` });
  }

  // ── disconnect ────────────────────────────────────────────────
  if (body.operation === 'disconnect') {
    await upsert({
      access_token: null, refresh_token: null, realm_id: null,
      token_expires_at: null, connected_at: null,
      status: 'disconnected', error_message: null,
    });
    return json({ ok: true });
  }

  return json({ error: 'Unknown operation' }, 400);
});
