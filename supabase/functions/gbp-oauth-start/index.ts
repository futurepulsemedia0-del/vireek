// gbp-oauth-start — begins the Google Business Profile connection (read-only use in Agent Readiness).
//   POST {}  (user JWT, owner/admin)  ->  { ok: true, url }   — the browser then navigates to `url`.
//
// Deploy: supabase functions deploy gbp-oauth-start
// Secrets: GOOGLE_BUSINESS_CLIENT_ID, GOOGLE_BUSINESS_STATE_SECRET (openssl rand -hex 32; its own secret, so a
//          state minted for another OAuth flow can never be replayed here)
// Google Cloud: add  <SUPABASE_URL>/functions/v1/gbp-oauth-callback  as an authorized redirect URI [VERIFY].
// The account is resolved from the JWT, never from the body.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { signState } from '../_shared/price-book/oauthState.ts';
import { buildAuthorizeUrl } from '../_shared/agent-readiness/gbpConnect.ts';
import { corsHeaders, json } from '../_shared/agent-readiness/edge.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth) return json({ ok: false, code: 'unauthorized' }, 401);
  const clientId = Deno.env.get('GOOGLE_BUSINESS_CLIENT_ID') ?? '';
  const stateSecret = Deno.env.get('GOOGLE_BUSINESS_STATE_SECRET') ?? '';
  if (!clientId || stateSecret.length < 32) return json({ ok: false, code: 'not_configured' }, 503);

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const who = await userClient.auth.getUser();
  if (who.error || !who.data.user) return json({ ok: false, code: 'unauthorized' }, 401);
  const ctx = await userClient.rpc('agent_readiness_context');
  if (ctx.error) return json({ ok: false, code: ctx.error.message.includes('forbidden') ? 'forbidden' : 'unauthorized' }, ctx.error.message.includes('forbidden') ? 403 : 401);
  const ownerId = (ctx.data as { owner_id?: string } | null)?.owner_id;
  if (!ownerId) return json({ ok: false, code: 'unauthorized' }, 401);

  const state = await signState(ownerId, stateSecret);
  return json({ ok: true, url: buildAuthorizeUrl(clientId, `${url}/functions/v1/gbp-oauth-callback`, state) });
});
