// supabase/functions/mfa-recovery/index.ts
//
// Recovery codes for Supabase Auth MFA (which has TOTP but no recovery codes).
//
//   { action: "status" }              → { remaining }                (any signed-in user)
//   { action: "generate" }            → { codes: ["ABCDE-FGHJK", …] } shown ONCE
//                                       Requires an AAL2 session (the person just proved
//                                       they hold their authenticator) and a verified TOTP factor.
//                                       Replaces every previous code.
//   { action: "redeem", code }        → { ok: true, factorsRemoved }
//                                       For the /mfa page when the authenticator is lost.
//                                       A valid code is burned, then the user's TOTP factors are
//                                       removed so the session no longer needs AAL2, and all other
//                                       codes are revoked. The person must re-enrol 2FA afterwards.
//
// Security notes
//   - Only an HMAC of each code is stored (pepper: MFA_RECOVERY_PEPPER, falling back to the
//     service-role key), bound to the user id.
//   - redeem is rate-limited: 5 failed attempts / 15 minutes / user, then 429.
//   - The code is burned with a conditional UPDATE … WHERE used_at IS NULL, so two simultaneous
//     requests cannot both redeem it.
//   - The service role bypasses RLS, so every query is explicitly scoped by user_id.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { generateCodes, formatCode, hashCode, isWellFormed, jwtClaim, normalizeCode } from "../_shared/mfa/recoveryCodes.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

interface AuthedUser {
  id: string;
  factors?: { id: string; factor_type: string; status: string }[] | null;
}

async function remainingCount(admin: SupabaseClient, userId: string): Promise<number> {
  const { count } = await admin
    .from("mfa_recovery_codes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("used_at", null);
  return count ?? 0;
}

async function handleGenerate(admin: SupabaseClient, user: AuthedUser, token: string, pepper: string) {
  const verifiedTotp = (user.factors ?? []).filter((f) => f.factor_type === "totp" && f.status === "verified");
  if (verifiedTotp.length === 0) return json({ error: "NO_FACTOR", detail: "Turn on two-factor authentication first." }, 409);
  if (jwtClaim(token, "aal") !== "aal2") {
    return json({ error: "AAL2_REQUIRED", detail: "Confirm your authenticator code by signing in again, then generate codes." }, 403);
  }

  const plain = generateCodes();
  const rows = await Promise.all(plain.map(async (c) => ({ user_id: user.id, code_hash: await hashCode(pepper, user.id, c) })));

  const { error: delError } = await admin.from("mfa_recovery_codes").delete().eq("user_id", user.id);
  if (delError) return json({ error: "DB_ERROR", detail: "Could not replace your recovery codes." }, 500);
  const { error: insError } = await admin.from("mfa_recovery_codes").insert(rows);
  if (insError) return json({ error: "DB_ERROR", detail: "Could not save your recovery codes." }, 500);

  return json({ codes: plain.map(formatCode), remaining: plain.length });
}

async function handleRedeem(admin: SupabaseClient, user: AuthedUser, code: unknown, pepper: string) {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MS).toISOString();
  const { count: failures } = await admin
    .from("mfa_recovery_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("success", false)
    .gte("created_at", since);
  if ((failures ?? 0) >= MAX_FAILED_ATTEMPTS) {
    return json({ error: "RATE_LIMITED", detail: "Too many incorrect codes. Please wait 15 minutes and try again." }, 429);
  }

  const normalized = typeof code === "string" ? normalizeCode(code) : "";
  const fail = async () => {
    await admin.from("mfa_recovery_attempts").insert({ user_id: user.id, success: false });
    return json({ error: "INVALID_CODE", detail: "That recovery code isn't valid or has already been used." }, 400);
  };
  if (!isWellFormed(normalized)) return await fail();

  const hash = await hashCode(pepper, user.id, normalized);
  const { data: burned, error } = await admin
    .from("mfa_recovery_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("code_hash", hash)
    .is("used_at", null)
    .select("id");
  if (error) return json({ error: "DB_ERROR", detail: "Could not check that code. Please try again." }, 500);
  if (!burned || burned.length === 0) return await fail();

  await admin.from("mfa_recovery_attempts").insert({ user_id: user.id, success: true });

  // The authenticator is lost: remove the TOTP factors so this account can sign in again,
  // and revoke every remaining code (they belonged to the factor that no longer exists).
  let removed = 0;
  const { data: factorData } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
  for (const f of factorData?.factors ?? []) {
    if (f.factor_type !== "totp") continue;
    const { error: delError } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id });
    if (delError) return json({ error: "FACTOR_REMOVAL_FAILED", detail: "Your code was accepted but 2FA could not be removed. Please try again." }, 500);
    removed++;
  }
  await admin.from("mfa_recovery_codes").delete().eq("user_id", user.id);

  return json({ ok: true, factorsRemoved: removed });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, { auth: { persistSession: false } });
  const pepper = Deno.env.get("MFA_RECOVERY_PEPPER") || serviceKey;
  if (!pepper) return json({ error: "NOT_CONFIGURED", detail: "Recovery codes aren't configured on the server." }, 500);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const user = userData.user as unknown as AuthedUser;

  const body = await req.json().catch(() => ({}));
  switch (body?.action) {
    case "status":
      return json({ remaining: await remainingCount(admin, user.id) });
    case "generate":
      return await handleGenerate(admin, user, token, pepper);
    case "redeem":
      return await handleRedeem(admin, user, body?.code, pepper);
    default:
      return json({ error: "Unknown action" }, 400);
  }
});
