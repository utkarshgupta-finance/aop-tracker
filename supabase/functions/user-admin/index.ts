const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function getCallerUserId(authHeader: string): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u.id ?? null;
}

async function checkIsAdmin(userId: string): Promise<boolean> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_access?user_id=eq.${userId}&select=is_admin&limit=1`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const rows = await r.json();
  return rows?.[0]?.is_admin === true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const callerId = await getCallerUserId(req.headers.get('Authorization') ?? '');
  if (!callerId) return json({ error: 'Unauthorized' }, 401);
  if (!(await checkIsAdmin(callerId))) return json({ error: 'Admin access required' }, 403);

  const sbH = {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  };
  const authH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  // list_users
  if (body.operation === 'list_users') {
    const [accR, authR] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/user_access?select=*&order=created_at`, { headers: sbH }),
      fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: authH }),
    ]);
    const accessRows = await accR.json();
    const authData   = await authR.json();
    const emailMap: Record<string, string> = {};
    for (const u of (authData.users ?? [])) emailMap[u.id] = u.email;
    return json({ ok: true, users: accessRows.map((r: Record<string,unknown>) => ({ ...r, email: emailMap[r.user_id as string] ?? '' })) });
  }

  // create_user
  if (body.operation === 'create_user') {
    const { email, password, display_name, allowed_tabs = [], allowed_bus = [], is_admin = false } = body as Record<string,unknown>;
    if (!email || !password || !display_name) return json({ error: 'email, password, display_name required' }, 400);
    const aR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST', headers: authH,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const authUser = await aR.json();
    if (!aR.ok) return json({ error: authUser.message ?? authUser }, 400);
    const iR = await fetch(`${SUPABASE_URL}/rest/v1/user_access`, {
      method: 'POST', headers: sbH,
      body: JSON.stringify({ user_id: authUser.id, display_name, allowed_tabs, allowed_bus, is_admin }),
    });
    if (!iR.ok) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${authUser.id}`, { method: 'DELETE', headers: authH });
      return json({ error: 'Failed to create access row' }, 500);
    }
    return json({ ok: true, user_id: authUser.id });
  }

  // update_user
  if (body.operation === 'update_user') {
    const { user_id, display_name, allowed_tabs, allowed_bus, is_admin, password } = body as Record<string,unknown>;
    if (!user_id) return json({ error: 'user_id required' }, 400);
    const patch: Record<string,unknown> = { updated_at: new Date().toISOString() };
    if (display_name !== undefined) patch.display_name = display_name;
    if (allowed_tabs !== undefined) patch.allowed_tabs = allowed_tabs;
    if (allowed_bus  !== undefined) patch.allowed_bus  = allowed_bus;
    if (is_admin     !== undefined) patch.is_admin     = is_admin;
    await fetch(`${SUPABASE_URL}/rest/v1/user_access?user_id=eq.${user_id}`, {
      method: 'PATCH', headers: sbH, body: JSON.stringify(patch),
    });
    if (password) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, {
        method: 'PUT', headers: authH, body: JSON.stringify({ password }),
      });
    }
    return json({ ok: true });
  }

  // delete_user
  if (body.operation === 'delete_user') {
    const { user_id } = body as Record<string,unknown>;
    if (!user_id) return json({ error: 'user_id required' }, 400);
    if (user_id === callerId) return json({ error: 'Cannot delete yourself' }, 400);
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, { method: 'DELETE', headers: authH });
    if (!r.ok) return json({ error: 'Delete failed' }, 500);
    return json({ ok: true });
  }

  return json({ error: 'Unknown operation' }, 400);
});
