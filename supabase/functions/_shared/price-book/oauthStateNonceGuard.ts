// supabase/functions/_shared/price-book/oauthStateNonceGuard.ts
// Deno wrapper: consumes the state nonce with a service-role client. Requires migration 20290304000000.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { consumeOAuthStateNonce } from "./oauthStateNonce.ts";

export function consumeOAuthStateOnce(state: string, provider: string): Promise<boolean> {
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  return consumeOAuthStateNonce(state, provider, (fn, args) => admin.rpc(fn, args));
}
