// supabase/functions/_shared/security/oauthStateBinding.ts
//
// Server-issued, single-use, session-bound OAuth state (pure logic: no Deno / npm imports, so Vitest runs it).
// Requires migration 20290306000000_oauth_state_binding.sql.
//
//   *-oauth-start  (has the caller's JWT)  -> issueBoundState()   after signing the HMAC state
//   *-oauth-callback (no session)          -> redeemBoundState()  after verifying the HMAC state
//
// The callback accepts the redirect only when the state was issued by us, has never been redeemed, is not
// expired, and the auth session that minted it is still alive. Everything fails closed.

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export type Redeemed =
  | { ok: true; userId: string; ownerId: string }
  | { ok: false; reason: "malformed" | "unknown_or_used" | "expired" | "session_ended" | "unavailable" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX24 = /^[0-9a-f]{24}$/;

function b64urlToString(s: string): string {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * Pulls the random nonce out of either state layout used in the project:
 *   accounting/crm : base64url(JSON{ n, ... }).signature
 *   price-book     : userId.timestamp.nonce24hex.signature
 * Returns null for anything else. Does NOT verify the signature: call it after the HMAC check.
 */
export function extractStateNonce(state: string): string | null {
  if (typeof state !== "string" || state.length === 0 || state.length > 2048) return null;
  const parts = state.split(".");
  if (parts.length === 4) return HEX24.test(parts[2]) ? parts[2] : null;
  if (parts.length === 2) {
    try {
      const n = (JSON.parse(b64urlToString(parts[0])) as { n?: unknown }).n;
      return typeof n === "string" && n.length >= 8 && n.length <= 128 ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 24-hex storage key = SHA-256(provider | stateNonce): the provider is part of the key, so a state never crosses providers. */
export async function deriveNonceKey(provider: string, stateNonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${provider}|${stateNonce}`));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads `session_id` from an access token that auth.getUser() ALREADY validated. Never use on an unvalidated token. */
export function sessionIdFromJwt(jwt: string): string | null {
  const parts = jwt.replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3) return null;
  try {
    const sid = (JSON.parse(b64urlToString(parts[1])) as { session_id?: unknown }).session_id;
    return typeof sid === "string" && UUID.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

export async function issueBoundState(
  rpc: Rpc,
  a: { state: string; provider: string; userId: string; ownerId: string; sessionId: string | null; ttlSeconds?: number },
): Promise<boolean> {
  const nonce = extractStateNonce(a.state);
  if (!nonce || !a.sessionId || !UUID.test(a.userId) || !UUID.test(a.ownerId)) return false;
  try {
    const { data, error } = await rpc("oauth_state_issue", {
      p_nonce: await deriveNonceKey(a.provider, nonce),
      p_provider: a.provider,
      p_user: a.userId,
      p_owner: a.ownerId,
      p_session: a.sessionId,
      p_ttl_seconds: a.ttlSeconds ?? 600,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function redeemBoundState(rpc: Rpc, state: string, provider: string): Promise<Redeemed> {
  const nonce = extractStateNonce(state);
  if (!nonce) return { ok: false, reason: "malformed" };
  try {
    const { data, error } = await rpc("oauth_state_redeem", { p_nonce: await deriveNonceKey(provider, nonce), p_provider: provider });
    if (error || !data || typeof data !== "object") return { ok: false, reason: "unavailable" };
    const d = data as { ok?: unknown; reason?: unknown; user_id?: unknown; owner_id?: unknown };
    if (d.ok === true && typeof d.user_id === "string" && typeof d.owner_id === "string" && UUID.test(d.user_id) && UUID.test(d.owner_id)) {
      return { ok: true, userId: d.user_id, ownerId: d.owner_id };
    }
    const reason = d.reason;
    return { ok: false, reason: reason === "expired" || reason === "session_ended" || reason === "malformed" ? reason : "unknown_or_used" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
