// supabase/functions/_shared/security/oauthStateBindingGuard.ts
// Deno wrapper: service-role RPC client for issue/redeem. Requires migration 20290306000000.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { issueBoundState, redeemBoundState, sessionIdFromJwt, type Redeemed } from "./oauthStateBinding.ts";

const admin = () =>
  createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

/** Call in *-oauth-start AFTER auth.getUser() accepted the JWT. Returns false => do not hand out the authorize URL. */
export function recordIssuedState(a: { state: string; provider: string; userId: string; ownerId: string; jwt: string }): Promise<boolean> {
  const db = admin();
  return issueBoundState((fn, args) => db.rpc(fn, args), {
    state: a.state, provider: a.provider, userId: a.userId, ownerId: a.ownerId, sessionId: sessionIdFromJwt(a.jwt),
  });
}

/** Call in *-oauth-callback AFTER the HMAC state verified. Consumes the state; a second call always fails. */
export function redeemIssuedState(state: string, provider: string): Promise<Redeemed> {
  const db = admin();
  return redeemBoundState((fn, args) => db.rpc(fn, args), state, provider);
}
