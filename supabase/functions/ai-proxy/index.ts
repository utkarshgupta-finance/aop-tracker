const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY secret not set in Supabase dashboard' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }

  let body: { system?: string; question?: string; messages?: {role:string;content:string}[] };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

  const { system, question, messages } = body;

  // Accept either messages array (conversational) or single question string
  const msgs: {role:string;content:string}[] = messages ?? (question ? [{ role: 'user', content: question }] : []);
  if (!msgs.length) {
    return new Response(JSON.stringify({ error: 'Missing messages or question' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      ...(system ? { system } : {}),
      messages: msgs,
    }),
  });

  const data = await anthropicResp.json();
  return new Response(JSON.stringify(data), {
    status: anthropicResp.status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
