// Authenticator-assurance helpers for edge functions.
// jwtAal() only DECODES the payload: call it on a JWT that admin.auth.getUser(jwt) has already validated.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export function jwtAal(jwt: string): string | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64)) as { aal?: unknown };
    return typeof payload.aal === "string" ? payload.aal : null;
  } catch {
    return null;
  }
}

/** True once an operator has set mfa_enforcement_policy.enforce_from to a past/current time. Fails CLOSED (true) on read error. */
export async function mfaEnforcementActive(admin: SupabaseClient): Promise<boolean> {
  const { data, error } = await admin.from("mfa_enforcement_policy").select("enforce_from").limit(1).maybeSingle();
  if (error) return true;
  const from = (data as { enforce_from: string | null } | null)?.enforce_from;
  return !!from && new Date(from).getTime() <= Date.now();
}
