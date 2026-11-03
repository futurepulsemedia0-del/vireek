// agent-readiness-scan — on-demand scan for the signed-in business (owner/admin).
//   POST {}  (user JWT)  ->  { ok, scan_id, score, coverage, subscores, checks, fixes, site, facts }
//
// Deploy: supabase functions deploy agent-readiness-scan
// Secrets: AGENT_READINESS_HASH_SALT
// The account is resolved server-side from the JWT (agent_readiness_context) — never from the request body.
// The score is computed here and stored by the service role, so a client can never forge or edit a scan.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { runAccountScan } from '../_shared/agent-readiness/runScan.ts';
import { corsHeaders, hashKey, json, productionDeps } from '../_shared/agent-readiness/edge.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth) return json({ ok: false, code: 'unauthorized' }, 401);
  const salt = Deno.env.get('AGENT_READINESS_HASH_SALT') ?? '';
  if (salt.length < 16) return json({ ok: false, code: 'not_configured' }, 503);

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const ctx = await userClient.rpc('agent_readiness_context');
  if (ctx.error) return json({ ok: false, code: ctx.error.message.includes('forbidden') ? 'forbidden' : 'unauthorized' }, ctx.error.message.includes('forbidden') ? 403 : 401);
  const ownerId = (ctx.data as { owner_id?: string } | null)?.owner_id;
  if (!ownerId) return json({ ok: false, code: 'unauthorized' }, 401);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  const allowed = await admin.rpc('consume_agent_readiness_limit', { p_key_hash: await hashKey(salt, `own:${ownerId}`), p_max: 12, p_window_seconds: 3600 });
  if (allowed.error) return json({ ok: false, code: 'unavailable' }, 503);
  if (allowed.data !== true) return json({ ok: false, code: 'rate_limited' }, 429, { 'Retry-After': '3600' });

  const run = await runAccountScan(admin, ownerId, 'manual', productionDeps());
  if (!run.ok) return json({ ok: false, code: run.code }, run.code === 'no_business_profile' ? 409 : 500);
  return json({ ok: true, scan_id: run.scanId, ...run.payload });
});
