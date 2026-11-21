// supabase/functions/dsar-non-customer/index.ts
//
// Staff-only handler for VERIFIED data-subject requests from people who are not Vireek customers
// (relationship customer_of_customer | website_visitor | other). dsar-request verifies identity and
// records the request; this function does the work that used to be manual:
//
//   POST { requestId, action: "discover" }  -> per-tenant row COUNTS (no content). Read-only.
//   POST { requestId, action: "process" }   -> acts on the request:
//        delete : adds the email to the suppression list, clears Vireek-derived property data for the
//                 subject's sites (dsar_erase_property_enrichment) and opens a referral for every tenant
//                 that controls matching customer/lead records.
//        access : referrals only. Nothing is disclosed automatically; staff answer the requester.
//        correct: referrals only (the tenant owns the record).
//
// Security: Bearer JWT of a profiles.is_staff user (checked here with the service role); the DSAR must be
// verified (status in_progress) and not already matched to an account owner. Idempotent: re-running
// "process" never duplicates suppressions or referrals. Responses carry counts and ids only.
// Deploy: supabase functions deploy dsar-non-customer   (JWT verification stays ON)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  checkEligibility,
  parseHandlerBody,
  planNonCustomerActions,
  referralDueAt,
  suppressionHash,
  toReferrals,
  type DiscoveryRow,
} from "../_shared/compliance/nonCustomerDsar.ts";
import { computeDueAt, normalizeEmail, type DsarKind } from "../_shared/compliance/dsar.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const MAX_BODY_BYTES = 4 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
const fail = (code: string, message: string, status: number) => json({ ok: false, code, message }, status);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return fail("method_not_allowed", "Method not allowed.", 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !anon || !svc) return fail("server_not_configured", "Server is not configured.", 500);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return fail("unauthorized", "Sign in as Vireek staff.", 401);

  const caller = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error: uErr } = await caller.auth.getUser();
  if (uErr || !u?.user) return fail("unauthorized", "Invalid or expired session.", 401);

  const admin = createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: staff } = await admin.from("profiles").select("is_staff").eq("id", u.user.id).maybeSingle();
  if (!staff?.is_staff) return fail("forbidden", "Staff only.", 403);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail("too_large", "Request is too large.", 413);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return fail("invalid_json", "Invalid JSON body.", 400);
  }
  const body = parseHandlerBody(parsedJson);
  if (!body.ok) return fail("validation", body.error, 422);

  const { data: dsar, error: dsarErr } = await admin
    .from("data_subject_requests")
    .select("id, reference, request_kind, requester_email, relationship, status, matched_user_id, due_at")
    .eq("id", body.requestId)
    .maybeSingle();
  if (dsarErr) return fail("server_error", "Could not read the request.", 500);

  const eligible = checkEligibility(dsar);
  if (!eligible.ok) {
    const msg: Record<string, string> = {
      not_found: "Request not found.",
      not_verified: "The requester has not verified their email yet, or the request is already closed.",
      account_flow: "This requester is an account owner: use the account erasure flow.",
      wrong_relationship: "Only non-customer requests are handled here.",
    };
    return fail(eligible.code, msg[eligible.code], eligible.code === "not_found" ? 404 : 409);
  }
  if (!dsar) return fail("not_found", "Request not found.", 404); // unreachable; narrows the type

  const email = normalizeEmail(dsar.requester_email);
  const kind = dsar.request_kind as DsarKind;
  const dueAt = dsar.due_at ? new Date(dsar.due_at) : computeDueAt(new Date());

  const { data: found, error: findErr } = await admin.rpc("dsar_discover_non_customer_data", { p_email: email });
  if (findErr) {
    console.error(JSON.stringify({ event: "dsar_non_customer_discover_failed", reference: dsar.reference, error: findErr.message }));
    return fail("server_error", "Could not search for matching data.", 500);
  }
  const discovery = (found ?? []) as DiscoveryRow[];

  if (body.action === "discover") {
    const referrals = toReferrals(discovery);
    return json({
      ok: true,
      reference: dsar.reference,
      kind,
      matches: referrals.map((r) => ({ tenant: r.tenantUserId, table: r.sourceTable, rows: r.rowCount })),
    });
  }

  // ------------------------------------------------------------------ process
  const plan = planNonCustomerActions(kind, discovery);
  const result = { suppressionAdded: false, profilesCleared: 0, layersDeleted: 0, addressSuppressionsAdded: 0, referralsOpened: 0 };

  if (plan.suppressEmail) {
    const hash = await suppressionHash("email", email);
    if (hash) {
      const { error } = await admin
        .from("data_subject_suppressions")
        .upsert({ key_kind: "email", key_hash: hash, reason: "deletion", dsar_id: dsar.id }, { onConflict: "key_kind,key_hash", ignoreDuplicates: true });
      if (error) return fail("server_error", "Could not record the suppression.", 500);
      result.suppressionAdded = true;
    }
  }

  if (plan.eraseEnrichment) {
    const { data: erased, error } = await admin.rpc("dsar_erase_property_enrichment", { p_email: email, p_dsar_id: dsar.id });
    if (error) {
      console.error(JSON.stringify({ event: "dsar_non_customer_erase_failed", reference: dsar.reference, error: error.message }));
      return fail("server_error", "Could not clear Vireek-derived property data.", 500);
    }
    const row = Array.isArray(erased) ? erased[0] : erased;
    result.profilesCleared = Number(row?.profiles_cleared ?? 0);
    result.layersDeleted = Number(row?.layers_deleted ?? 0);
    result.addressSuppressionsAdded = Number(row?.suppressions_added ?? 0);
  }

  if (plan.referrals.length > 0) {
    const due = referralDueAt(dueAt).toISOString();
    const rows = plan.referrals.map((r) => ({
      dsar_id: dsar.id,
      tenant_user_id: r.tenantUserId,
      request_kind: kind,
      source_table: r.sourceTable,
      row_count: r.rowCount,
      subject_email: email,
      due_at: due,
    }));
    const { data: inserted, error } = await admin
      .from("dsar_controller_referrals")
      .upsert(rows, { onConflict: "dsar_id,tenant_user_id,source_table", ignoreDuplicates: true })
      .select("id");
    if (error) return fail("server_error", "Could not create controller referrals.", 500);
    result.referralsOpened = inserted?.length ?? 0;
  }

  const patch: Record<string, unknown> = { resolution_note: plan.note };
  if (plan.finalStatus === "completed") {
    patch.status = "completed";
    patch.completed_at = new Date().toISOString();
  }
  const { error: updErr } = await admin.from("data_subject_requests").update(patch).eq("id", dsar.id).eq("status", "in_progress");
  if (updErr) return fail("server_error", "Actions ran but the request record could not be updated.", 500);

  try {
    await admin.rpc("log_audit_event", {
      p_user_id: u.user.id,
      p_action: `dsar_non_customer:${kind}`,
      p_target_table: "data_subject_requests",
      p_target_id: dsar.id,
    });
  } catch { /* the DSAR row is the durable record; audit is best-effort here, like dsar-request */ }

  console.log(JSON.stringify({ event: "dsar_non_customer_processed", reference: dsar.reference, kind, ...result, status: plan.finalStatus }));
  return json({ ok: true, reference: dsar.reference, kind, status: plan.finalStatus, ...result, note: plan.note });
});
