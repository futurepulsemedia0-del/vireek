// supabase/functions/_shared/price-book/oauthStateNonce.ts
//
// Single-use enforcement for the signed OAuth `state` (see oauthState.ts: format `userId.ts.nonce.sig`).
// verifyState() proves authenticity + freshness (10 min); this module makes a verified state usable ONCE by recording
// its nonce through the service-role-only RPC oauth_state_consume(). Call it ONLY AFTER verifyState() succeeded.
// Fails closed: any RPC error or non-true result means "do not proceed".

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/** Returns the 24-hex nonce of a state string, or null if the shape is wrong. */
export function stateNonce(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  return /^[0-9a-f]{24}$/.test(parts[2]) ? parts[2] : null;
}

export async function consumeOAuthStateNonce(state: string, provider: string, rpc: Rpc): Promise<boolean> {
  const nonce = stateNonce(state);
  if (!nonce) return false;
  try {
    const { data, error } = await rpc("oauth_state_consume", { p_nonce: nonce, p_provider: provider });
    return !error && data === true;
  } catch {
    return false;
  }
}
