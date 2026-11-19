// gbp-oauth-callback — Google redirects the browser here after consent. Public (no JWT): the signed `state` is the identity.
//
// Deploy: supabase functions deploy gbp-oauth-callback --no-verify-jwt
// Secrets: GOOGLE_BUSINESS_CLIENT_ID, GOOGLE_BUSINESS_CLIENT_SECRET, GOOGLE_BUSINESS_STATE_SECRET, SITE_URL
//
// Order matters: tokens go to the credential vault first; the integration row is written only after the vault
// accepted them, and the vault entry is removed again if that write fails. Tokens are never logged, never put in
// the redirect URL and never stored in `integrations.config`.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { verifyState } from '../_shared/price-book/oauthState.ts';
import { deleteSecrets, saveSecrets } from '../_shared/secrets/providerCredentials.ts';
import { exchangeCode, listCandidates } from '../_shared/agent-readiness/gbpConnect.ts';
import type { GbpFetch } from '../_shared/agent-readiness/gbpClient.ts';

Deno.serve(async (req: Request) => {
  const siteUrl = (Deno.env.get('SITE_URL') || 'https://vireek.com').replace(/\/$/, '');
  const back = (status: string, reason?: string): Response => {
    const dest = new URL(`${siteUrl}/dashboard/agent-readiness`);
    dest.searchParams.set('gbp', status);
    if (reason) dest.searchParams.set('reason', reason);
    return Response.redirect(dest.toString(), 302);
  };
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const q = new URL(req.url).searchParams;
  if (q.get('error')) return back('error', q.get('error') === 'access_denied' ? 'access_denied' : 'google_error');
  const code = q.get('code') ?? '';
  const state = q.get('state') ?? '';
  if (!code || !state || code.length > 2048 || state.length > 512) return back('error', 'missing_code_or_state');

  const stateSecret = Deno.env.get('GOOGLE_BUSINESS_STATE_SECRET') ?? '';
  const clientId = Deno.env.get('GOOGLE_BUSINESS_CLIENT_ID') ?? '';
  const clientSecret = Deno.env.get('GOOGLE_BUSINESS_CLIENT_SECRET') ?? '';
  if (!clientId || !clientSecret || stateSecret.length < 32) return back('error', 'not_configured');
  const ownerId = await verifyState(state, stateSecret);
  if (!ownerId || !/^[0-9a-f-]{36}$/.test(ownerId)) return back('error', 'invalid_state');

  const supaUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const doFetch: GbpFetch = (url, init) => fetch(url, init);
  const now = (): number => Date.now();
  const tok = await exchangeCode(doFetch, { clientId, clientSecret, redirectUri: `${supaUrl}/functions/v1/gbp-oauth-callback`, code }, now);
  if (!tok.ok) return back('error', tok.code);

  const found = await listCandidates(doFetch, tok.accessToken);
  if (!found.ok) return back('error', found.code);
  if (found.candidates.length === 0) return back('error', 'no_locations');

  const admin = createClient(supaUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  try {
    await saveSecrets(admin, ownerId, 'google_business_profile', { access_token: tok.accessToken, refresh_token: tok.refreshToken });
  } catch {
    return back('error', 'save_failed');
  }
  const saved = await admin.rpc('gbp_connect_save', { p_user: ownerId, p_expires_at: tok.expiresAt, p_candidates: found.candidates });
  if (saved.error) {
    await deleteSecrets(admin, ownerId, 'google_business_profile').catch(() => undefined);
    console.error(JSON.stringify({ event: 'gbp_connect_save_failed' }));
    return back('error', 'save_failed');
  }
  const selected = (saved.data as { selected?: boolean } | null)?.selected === true;
  return back(selected ? 'connected' : 'choose');
});
