// supabase/functions/staff-impersonate/index.ts
//
// Audited "sign in as customer" for Vireek staff.
//
//   POST { "action": "start", "accountId": "<uuid>", "reason": "...", "ticketRef"?: "ZD-1042" }
//        -> { sessionId, expiresAt, link }      (link = one-time sign-in URL for the customer's account)
//   POST { "action": "end", "sessionId": "<uuid>" }
//        -> { ok: true }
//
// Guarantees (in this order, so there is never un-audited access):
//   1. Caller must present a valid JWT AND profiles.is_staff = true (checked with the
//      service role, never trusted from the client). Non-staff attempts are logged.
//   2. Reason (>= 15 chars) and ticket format are validated by the SAME function the UI
//      uses (_shared/staff/accountExplorer.ts), so the UI can never be looser than this API.
//   3. Targets that are staff accounts, or the caller themself, are refused.
//   4. At most 10 sessions per staff member per hour.
//   5. The session row and BOTH audit trails (internal staff_audit_log + the customer's own
//      audit_log, so the customer can see "Vireek Support signed in") are written BEFORE the
//      sign-in link is generated. If link generation fails, the session is closed and logged.
//   6. The link is returned once to the staff browser and is never logged or stored.
//
// Deploy:  supabase functions deploy staff-impersonate
// Env:     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (set by Supabase), SITE_URL (optional)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  IMPERSONATION_MAX_PER_HOUR,
  IMPERSONATION_MINUTES,
  impersonationDenial,
  validateImpersonationRequest,
} from "../_shared/staff/accountExplorer.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function audit(
  admin: SupabaseClient,
  row: { staff_id: string | null; staff_email: string | null; action: string; target_account_id?: string | null; reason?: string | null; metadata?: Record<string, unknown> },
) {
  const { error } = await admin.from("staff_audit_log").insert({ metadata: {}, ...row });
  if (error) throw new Error(`audit_failed:${error.message}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);
  const staffId = userData.user.id;
  const staffEmail = userData.user.email ?? null;

  let body: { action?: string; accountId?: string; reason?: string; ticketRef?: string | null; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  try {
    // 1. Staff gate (server-side, service role).
    const { data: staffProfile } = await admin.from("profiles").select("is_staff").eq("id", staffId).maybeSingle();
    if (!staffProfile?.is_staff) {
      await audit(admin, { staff_id: staffId, staff_email: staffEmail, action: "impersonation_denied", target_account_id: UUID.test(body.accountId ?? "") ? body.accountId : null, metadata: { why: "not_staff" } });
      return jsonResponse({ error: "Staff access required." }, 403);
    }

    // ---------------- END ----------------
    if (body.action === "end") {
      if (!UUID.test(body.sessionId ?? "")) return jsonResponse({ error: "Invalid session." }, 400);
      const { data: session } = await admin
        .from("staff_impersonation_sessions")
        .update({ ended_at: new Date().toISOString() })
        .eq("id", body.sessionId)
        .eq("staff_id", staffId)
        .is("ended_at", null)
        .select("id, target_account_id")
        .maybeSingle();
      if (session) {
        await audit(admin, { staff_id: staffId, staff_email: staffEmail, action: "impersonation_end", target_account_id: session.target_account_id, metadata: { session_id: session.id } });
        await admin.from("audit_log").insert({ user_id: session.target_account_id, actor_id: staffId, actor_email: "Vireek Support", action: "staff_impersonation_ended", target_table: "profiles", target_id: session.target_account_id });
      }
      return jsonResponse({ ok: true });
    }

    // ---------------- START ----------------
    if (body.action !== "start") return jsonResponse({ error: "Unknown action." }, 400);
    if (!UUID.test(body.accountId ?? "")) return jsonResponse({ error: "Invalid account." }, 400);
    const accountId = body.accountId as string;
    const reason = (body.reason ?? "").trim();
    const ticketRef = (body.ticketRef ?? "").trim() || null;

    const problems = validateImpersonationRequest({ reason, ticketRef });
    if (problems.length > 0) return jsonResponse({ error: problems[0] }, 400);

    const { data: target } = await admin.from("profiles").select("id, email, is_staff, role").eq("id", accountId).maybeSingle();
    if (!target || target.role !== "owner" || !target.email) return jsonResponse({ error: "Account not found." }, 404);

    const denial = impersonationDenial({ id: target.id, isStaff: target.is_staff === true }, staffId);
    if (denial) {
      await audit(admin, { staff_id: staffId, staff_email: staffEmail, action: "impersonation_denied", target_account_id: accountId, reason, metadata: { why: denial } });
      return jsonResponse({ error: denial }, 403);
    }

    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await admin.from("staff_impersonation_sessions").select("id", { count: "exact", head: true }).eq("staff_id", staffId).gte("started_at", since);
    if ((count ?? 0) >= IMPERSONATION_MAX_PER_HOUR) {
      return jsonResponse({ error: `Limit reached: at most ${IMPERSONATION_MAX_PER_HOUR} customer sessions per hour.` }, 429);
    }

    const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60_000).toISOString();
    const { data: session, error: sessionError } = await admin
      .from("staff_impersonation_sessions")
      .insert({ staff_id: staffId, target_account_id: accountId, reason, ticket_ref: ticketRef, expires_at: expiresAt })
      .select("id")
      .single();
    if (sessionError || !session) throw new Error("session_insert_failed");

    // Audit BEFORE the link exists.
    await audit(admin, { staff_id: staffId, staff_email: staffEmail, action: "impersonation_start", target_account_id: accountId, reason, metadata: { session_id: session.id, ticket_ref: ticketRef, expires_at: expiresAt } });
    await admin.from("audit_log").insert({ user_id: accountId, actor_id: staffId, actor_email: "Vireek Support", action: "staff_impersonation_started", target_table: "profiles", target_id: accountId });

    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: target.email,
      options: { redirectTo: `${siteUrl}/dashboard` },
    });
    const link = linkData?.properties?.action_link;
    if (linkError || !link) {
      await admin.from("staff_impersonation_sessions").update({ ended_at: new Date().toISOString() }).eq("id", session.id);
      await audit(admin, { staff_id: staffId, staff_email: staffEmail, action: "impersonation_end", target_account_id: accountId, metadata: { session_id: session.id, why: "link_generation_failed" } });
      return jsonResponse({ error: "Could not create a sign-in link. The attempt was logged." }, 502);
    }

    return jsonResponse({ sessionId: session.id, expiresAt, link });
  } catch (err) {
    // Never echo internals or the link; the audit trail is the source of truth.
    console.error(JSON.stringify({ event: "staff_impersonate_error", error: (err as Error).message }));
    return jsonResponse({ error: "Something went wrong. Nothing was changed." }, 500);
  }
});
