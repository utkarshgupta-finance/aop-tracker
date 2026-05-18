const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sbH = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates,return=representation',
};

function htmlPage(title: string, message: string, success: boolean): Response {
  const color = success ? '#3b6d11' : '#a32d2d';
  const status = success ? 'connected' : 'error';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>QuickBooks ${title}</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f6f9}
.box{background:#fff;border-radius:10px;padding:2rem 2.5rem;max-width:420px;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,.08)}
h2{color:${color};margin-bottom:.75rem}.msg{color:#4a5568;font-size:14px;line-height:1.6}</style>
</head><body>
<div class="box">
  <h2>${title}</h2>
  <p class="msg">${message}</p>
  <p class="msg" style="margin-top:1rem;color:#94a3b8;font-size:12px">This window will close automatically…</p>
</div>
<script>
  try { window.opener.postMessage({ qb_oauth: '${status}' }, '*'); } catch(_) {}
  setTimeout(() => window.close(), 2000);
</script>
</body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url    = new URL(req.url);
  const code   = url.searchParams.get('code');
  const state  = url.searchParams.get('state');
  const realmId = url.searchParams.get('realmId');
  const error  = url.searchParams.get('error');

  if (error) {
    return htmlPage('Authorization Failed', `QuickBooks returned: ${error}`, false);
  }

  if (!code || !state || !realmId) {
    return htmlPage('Authorization Failed', 'Missing required parameters from QuickBooks.', false);
  }

  // Fetch stored settings to verify state and get credentials
  const rowR = await fetch(
    `${SUPABASE_URL}/rest/v1/integration_settings?id=eq.quickbooks&limit=1`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const rows = await rowR.json();
  const row = rows?.[0];

  if (!row) {
    return htmlPage('Authorization Failed', 'No QuickBooks settings found. Please configure credentials first.', false);
  }

  if (!row.oauth_state || row.oauth_state !== state) {
    return htmlPage('Authorization Failed', 'Invalid OAuth state — possible CSRF. Please try connecting again.', false);
  }

  // Exchange authorization code for tokens
  const redirectUri = `${url.origin}${url.pathname}`;
  const credentials = btoa(`${row.client_id}:${row.client_secret}`);

  const tokenR = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokens = await tokenR.json();

  if (!tokenR.ok || tokens.error || !tokens.access_token) {
    const msg = tokens.error_description ?? tokens.error ?? 'Token exchange failed';
    await fetch(`${SUPABASE_URL}/rest/v1/integration_settings`, {
      method: 'POST',
      headers: sbH,
      body: JSON.stringify({ id: 'quickbooks', status: 'error', error_message: msg, updated_at: new Date().toISOString() }),
    });
    return htmlPage('Authorization Failed', `Could not exchange code for tokens: ${msg}`, false);
  }

  const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();

  await fetch(`${SUPABASE_URL}/rest/v1/integration_settings`, {
    method: 'POST',
    headers: sbH,
    body: JSON.stringify({
      id:               'quickbooks',
      access_token:     tokens.access_token,
      refresh_token:    tokens.refresh_token ?? null,
      realm_id:         realmId,
      token_expires_at: expiresAt,
      oauth_state:      null,
      connected_at:     new Date().toISOString(),
      status:           'connected',
      error_message:    null,
      updated_at:       new Date().toISOString(),
    }),
  });

  return htmlPage(
    'Connected!',
    `QuickBooks has been connected successfully.<br>Company ID: <code>${realmId}</code>`,
    true
  );
});
