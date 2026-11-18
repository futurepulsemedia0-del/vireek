// Impersonation guard for edge functions that move money, touch credentials or export data.
//
// Staff "sign in as customer" sessions are marked by public.custom_access_token_hook() with an `imp` claim
// (see supabase/migrations/20290306000100_impersonation_limits.sql). Call blockIfImpersonating() right after the
// caller's JWT has been validated with admin.auth.getUser(jwt):
//
//   const imp = await blockIfImpersonating(admin, jwt, "issue-refund");
//   if (imp) return imp;
//
// impersonationClaim() only DECODES the payload; never call it on an unvalidated token. The claim's own `exp`
// is NOT trusted: the session row is re-read with the service role, so an ended/expired session is refused even
// if the access token has not expired yet. Every check fails CLOSED.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export interface ImpersonationClaim {
  sid: string;
  staff: string;
  exp: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
  "Content-Type": "application/json",
};

function respond(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), { status, headers: CORS });
}

export function impersonationClaim(jwt: string): ImpersonationClaim | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64)) as { imp?: { sid?: unknown; staff?: unknown; exp?: unknown } | null };
    const imp = payload.imp;
    if (!imp || typeof imp !== "object") return null;
    if (typeof imp.sid !== "string" || !UUID.test(imp.sid)) return null;
    return {
      sid: imp.sid,
      staff: typeof imp.staff === "string" ? imp.staff : "",
      exp: typeof imp.exp === "number" ? imp.exp : 0,
    };
  } catch {
    return null;
  }
}

export interface ImpersonationSessionRow {
  id: string;
  staff_id: string;
  target_account_id: string;
  expires_at: string;
  ended_at: string | null;
}

/** True only while the session row exists, is not ended and expires_at is in the future. */
export function sessionIsLive(row: ImpersonationSessionRow | null, now: number = Date.now()): boolean {
  if (!row || row.ended_at) return false;
  const exp = Date.parse(row.expires_at);
  return Number.isFinite(exp) && exp > now;
}

/**
 * Returns null when the caller is not in a support session. Otherwise returns the Response to send back:
 *  - 401 impersonation_expired  the session ended/expired (it is closed and its auth session revoked best-effort)
 *  - 403 impersonation_blocked  the action is not allowed in a support session (audited to staff + customer)
 *  - 503 impersonation_check_failed  the session could not be verified (fail closed)
 */
export async function blockIfImpersonating(admin: SupabaseClient, jwt: string, action: string): Promise<Response | null> {
  const claim = impersonationClaim(jwt);
  if (!claim) return null;

  const { data, error } = await admin
    .from("staff_impersonation_sessions")
    .select("id, staff_id, target_account_id, expires_at, ended_at")
    .eq("id", claim.sid)
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ event: "impersonation_check_failed", action, error: error.message }));
    return respond(503, "impersonation_check_failed", "Could not verify the support session. Nothing was changed.");
  }

  const row = (data ?? null) as ImpersonationSessionRow | null;
  if (!sessionIsLive(row)) {
    if (row && !row.ended_at) {
      await admin.rpc("impersonation_close", { p_session: row.id, p_reason: "expired" }).then(() => undefined, () => undefined);
    }
    return respond(401, "impersonation_expired", "This support session has ended.");
  }
  const live = row as ImpersonationSessionRow;

  // Audit the blocked attempt. Failures are logged, never allowed to turn the block into an allow.
  const metadata = { action, session_id: live.id, blocked: true };
  const staffLog = await admin.from("staff_audit_log").insert({
    staff_id: live.staff_id,
    staff_email: null,
    action: "impersonation_blocked",
    target_account_id: live.target_account_id,
    metadata,
  });
  const customerLog = await admin.from("audit_log").insert({
    user_id: live.target_account_id,
    actor_id: live.staff_id,
    actor_email: "Vireek Support",
    action: "staff_impersonation_action_blocked",
    target_table: "profiles",
    target_id: live.target_account_id,
    details: { action },
  });
  if (staffLog.error || customerLog.error) {
    console.error(JSON.stringify({ event: "impersonation_block_audit_failed", action, staff: staffLog.error?.message, customer: customerLog.error?.message }));
  }

  return respond(403, "impersonation_blocked", "This action is not available during a Vireek Support session.");
}
