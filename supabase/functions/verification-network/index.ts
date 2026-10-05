// supabase/functions/verification-network/index.ts
//
// VIREEK Verification Network - orchestrator.
//
// Actions (POST JSON):
//   request { technicianId, kind, credentialId?, policyId?, jurisdiction? }   manager (any tech) | technician (self)
//   resolve { checkId, outcome: "verified"|"adverse", note, reference?, licenseStatus?, expiresOn? }   manager only
//   sweep   {}                                                                service role only (cron)
//
// Auth  : callers send their JWT. Account owner / manager / own technician id are resolved with RPCs
//         under the CALLER's identity. The service role is used only to queue, claim and finalise checks,
//         so a verification result can never be written from the browser.
// Secrets: optional SOCRATA_APP_TOKEN (raises the public-data rate limit). Nothing else beyond SUPABASE_*.
// No LLM is called: every decision is deterministic, explainable and unit-tested (engine.ts).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  MAX_ATTEMPTS,
  decisionFromManual,
  evaluateInsurancePolicy,
  evaluateLicenseRecords,
  inferJurisdiction,
  isValidJurisdiction,
  licenseNumberCandidates,
  nextCheckAt,
  normalizeLicenseNumber,
  sealEvidence,
  toIsoDate,
  type Decision,
  type FinalStatus,
  type LicenseStatus,
  type PolicyInput,
  type VerificationKind,
} from "../_shared/verification-network/engine.ts";
import { querySocrata, validateSocrataConfig, type FetchLike } from "../_shared/verification-network/socrata.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: VerificationKind[] = ["license", "insurance", "background"];
const LICENSE_STATUSES: LicenseStatus[] = ["active", "inactive", "expired", "suspended", "revoked", "unknown"];
const MAX_USER_REQUESTS_PER_HOUR = 30;
const SWEEP_BATCH = 25;
const SWEEP_BUDGET_MS = 45_000;
const CONCURRENCY = 5;

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function asUuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new HttpError(400, `${field} must be a UUID`);
  return v;
}

interface CheckRow {
  id: string; account_owner_id: string; technician_id: string; kind: VerificationKind; subject_key: string;
  credential_id: string | null; insurance_policy_id: string | null; jurisdiction: string | null;
  subject_identifier: string | null; subject_fingerprint: string; attempts: number;
}

interface Caller {
  userId: string; ownerId: string; isManager: boolean; myTechnicianId: string | null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function authenticate(req: Request, url: string, anonKey: string): Promise<Caller> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) throw new HttpError(401, "Authentication required");
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) throw new HttpError(401, "Invalid session");
  const [owner, manager, mine] = await Promise.all([
    userClient.rpc("get_account_owner_id"),
    userClient.rpc("identity_is_manager"),
    userClient.rpc("get_my_team_member_id"),
  ]);
  if (owner.error || !owner.data) throw new HttpError(403, "No account found for this user");
  return {
    userId: userData.user.id,
    ownerId: owner.data as string,
    isManager: manager.data === true,
    myTechnicianId: (mine.data as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Check execution
// ---------------------------------------------------------------------------

async function finalize(admin: SupabaseClient, check: CheckRow, decision: Decision, sourceId: string | null, sourceKey: string | null, jurisdiction: string | null, errorMessage: string | null = null) {
  const now = new Date();
  const checkedAt = now.toISOString();
  const seal = await sealEvidence({ kind: check.kind, sourceKey, subjectFingerprint: check.subject_fingerprint, checkedAt, decision });
  const next = nextCheckAt(decision, check.kind, now, check.attempts);

  const { data: prev } = await admin
    .from("verification_checks")
    .select("status")
    .eq("technician_id", check.technician_id).eq("kind", check.kind).eq("subject_key", check.subject_key)
    .neq("status", "pending").order("created_at", { ascending: false }).limit(1).maybeSingle();

  const { data: updated, error } = await admin.from("verification_checks").update({
    status: decision.status, reason: decision.reason, method: decision.method, source_id: sourceId,
    jurisdiction, license_status: decision.licenseStatus, holder_name: decision.holderName,
    name_match_score: decision.nameMatchScore, classification: decision.classification,
    expires_on: decision.expiresOn, disciplinary_flag: decision.disciplinaryFlag,
    coverage_cents: decision.coverageCents, carrier: decision.carrier, evidence: decision.evidence,
    evidence_sha256: seal, error_message: errorMessage?.slice(0, 500) ?? null,
    checked_at: checkedAt, next_check_at: next ? next.toISOString() : null,
  }).eq("id", check.id).eq("status", "pending").select("id");
  if (error) throw new Error(`finalize failed: ${error.message}`);
  if (!updated || updated.length === 0) throw new Error("check was already finalised");

  const events: Record<string, unknown>[] = [{
    check_id: check.id, account_owner_id: check.account_owner_id, technician_id: check.technician_id,
    event_type: decision.status === "error" ? "error" : "completed",
    payload: { status: decision.status, reason: decision.reason, method: decision.method },
  }];
  const previous = (prev?.status as string | undefined) ?? null;
  if (previous && previous !== decision.status) {
    events.push({
      check_id: check.id, account_owner_id: check.account_owner_id, technician_id: check.technician_id,
      event_type: "status_changed", payload: { from: previous, to: decision.status },
    });
  }
  await admin.from("verification_events").insert(events);

  const regression = decision.status === "adverse" && previous !== "adverse";
  if (regression) await notifyAdverse(admin, check, decision);
  return { status: decision.status as FinalStatus, reason: decision.reason };
}

async function notifyAdverse(admin: SupabaseClient, check: CheckRow, d: Decision) {
  try {
    const { data: tech } = await admin.from("team_members").select("member_name").eq("id", check.technician_id).maybeSingle();
    const name = (tech?.member_name as string | null) ?? "A technician";
    const label = check.kind === "license" ? "licence" : check.kind === "insurance" ? "insurance policy" : "background check";
    await admin.from("notifications").insert({
      user_id: check.account_owner_id,
      type: "credential_expiry",
      title: `Verification alert: ${label}`,
      message: `${name}'s ${label} failed external verification (${d.reason.replace(/_/g, " ")}). Review before dispatching.`,
      action_url: "/dashboard/verification-network",
      ...(check.credential_id ? { credential_id: check.credential_id } : {}),
    });
  } catch {
    /* notification is best-effort; the verification result itself is already stored */
  }
}

function review(reason: string): Decision {
  return {
    status: "needs_review", reason, licenseStatus: null, holderName: null, nameMatchScore: null, classification: null,
    expiresOn: null, disciplinaryFlag: null, coverageCents: null, carrier: null, method: "rules_engine", evidence: {},
  };
}

async function runCheck(admin: SupabaseClient, check: CheckRow): Promise<{ status: FinalStatus; reason: string }> {
  let sourceId: string | null = null;
  let sourceKey: string | null = null;
  let jurisdiction = check.jurisdiction;
  try {
    const today = toIsoDate(new Date());

    if (check.kind === "insurance") {
      const { data: policy } = check.insurance_policy_id
        ? await admin.from("technician_insurance_policies")
            .select("policy_type, carrier, status, expires_at, effective_date, coverage_amount_cents, verified_at")
            .eq("id", check.insurance_policy_id).maybeSingle()
        : { data: null };
      const decision = policy ? evaluateInsurancePolicy(policy as PolicyInput, today) : review("policy_missing");
      return await finalize(admin, check, decision, null, null, null);
    }

    if (check.kind === "background") {
      const { data: consent } = await admin.from("background_consents").select("id")
        .eq("technician_id", check.technician_id).is("revoked_at", null).limit(1).maybeSingle();
      // No automated provider is connected: the result is recorded by a manager from the vendor report.
      return await finalize(admin, check, review(consent ? "awaiting_provider" : "consent_missing"), null, null, null);
    }

    // ---- licence ----
    const { data: cred } = check.credential_id
      ? await admin.from("technician_credentials")
          .select("credential_number, issuing_authority, credential_name").eq("id", check.credential_id).maybeSingle()
      : { data: null };
    if (!cred) return await finalize(admin, check, review("credential_missing"), null, null, null);

    const number = check.subject_identifier ?? normalizeLicenseNumber(cred.credential_number);
    if (!number) return await finalize(admin, check, review("missing_license_number"), null, null, jurisdiction);

    jurisdiction = jurisdiction ?? inferJurisdiction(cred.issuing_authority) ?? inferJurisdiction(cred.credential_name);
    if (!jurisdiction) return await finalize(admin, check, review("jurisdiction_unknown"), null, null, null);

    const { data: source } = await admin.from("verification_sources").select("id, source_key, provider, config")
      .eq("kind", "license").eq("jurisdiction", jurisdiction).eq("active", true).limit(1).maybeSingle();
    if (!source) return await finalize(admin, check, review("no_source_for_jurisdiction"), null, null, jurisdiction);
    sourceId = source.id as string;
    sourceKey = source.source_key as string;

    const cfg = validateSocrataConfig(source.config);
    if (!cfg.ok) {
      console.error(`verification source ${sourceKey} misconfigured: ${cfg.error}`);
      return await finalize(admin, check, review("source_misconfigured"), sourceId, sourceKey, jurisdiction);
    }

    const [{ data: tech }, { data: owner }] = await Promise.all([
      admin.from("team_members").select("member_name").eq("id", check.technician_id).maybeSingle(),
      admin.from("profiles").select("company_name").eq("id", check.account_owner_id).maybeSingle(),
    ]);
    const candidates = licenseNumberCandidates(number);
    const wanted = new Set(candidates);
    const records = (await querySocrata(cfg.config, candidates, fetch as unknown as FetchLike, Deno.env.get("SOCRATA_APP_TOKEN") ?? undefined))
      .filter((r) => r.licenseNumber !== null && wanted.has(normalizeLicenseNumber(r.licenseNumber)));

    const holderNames = [tech?.member_name as string | null, owner?.company_name as string | null].filter((x): x is string => !!x);
    const decision = evaluateLicenseRecords(records, { holderNames, today, statusMap: cfg.config.status_map });
    return await finalize(admin, check, decision, sourceId, sourceKey, jurisdiction);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const exhausted = check.attempts >= MAX_ATTEMPTS;
    const decision = review(exhausted ? "provider_unavailable" : "provider_error");
    if (!exhausted) decision.status = "error";
    return await finalize(admin, check, decision, sourceId, sourceKey, jurisdiction, message);
  }
}

async function claim(admin: SupabaseClient, limit: number, id?: string): Promise<CheckRow[]> {
  const { data, error } = await admin.rpc("verification_claim_pending", { p_limit: limit, p_id: id ?? null });
  if (error) throw new Error(`claim failed: ${error.message}`);
  return (data as CheckRow[]) ?? [];
}

async function mapPool<T>(items: T[], size: number, fn: (x: T) => Promise<unknown>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch (e) { console.error("check failed", e instanceof Error ? e.message : e); }
    }
  }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function actionRequest(admin: SupabaseClient, caller: Caller, body: Record<string, unknown>) {
  const technicianId = asUuid(body.technicianId, "technicianId");
  const kind = body.kind as VerificationKind;
  if (!KINDS.includes(kind)) throw new HttpError(400, "kind must be license, insurance or background");
  const isSelf = caller.myTechnicianId === technicianId;
  if (!caller.isManager && !(isSelf && kind !== "background")) throw new HttpError(403, "Not allowed to verify this technician");

  const credentialId = kind === "license" ? asUuid(body.credentialId, "credentialId") : null;
  const policyId = kind === "insurance" ? asUuid(body.policyId, "policyId") : null;
  let jurisdiction: string | null = null;
  if (body.jurisdiction !== undefined && body.jurisdiction !== null && body.jurisdiction !== "") {
    if (!isValidJurisdiction(body.jurisdiction)) throw new HttpError(400, "jurisdiction must look like US-TX");
    jurisdiction = body.jurisdiction;
  }

  if (kind === "background") {
    const { data: consent } = await admin.from("background_consents").select("id")
      .eq("technician_id", technicianId).eq("account_owner_id", caller.ownerId).is("revoked_at", null).limit(1).maybeSingle();
    if (!consent) throw new HttpError(409, "The technician has not given background-check consent", "consent_missing");
  }

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await admin.from("verification_checks").select("id", { count: "exact", head: true })
    .eq("account_owner_id", caller.ownerId).eq("requested_by", caller.userId).gte("created_at", since);
  if ((count ?? 0) >= MAX_USER_REQUESTS_PER_HOUR) throw new HttpError(429, "Too many verification requests. Try again later.");

  const { data: checkId, error } = await admin.rpc("verification_enqueue_subject", {
    p_owner: caller.ownerId, p_technician: technicianId, p_kind: kind, p_credential: credentialId,
    p_policy: policyId, p_jurisdiction: jurisdiction, p_requested_by: caller.userId,
  });
  if (error) throw new HttpError(error.code === "P0002" ? 404 : 400, error.message);

  const claimed = await claim(admin, 1, checkId as string);
  if (claimed.length) await runCheck(admin, claimed[0]);

  const { data: row } = await admin.from("verification_checks")
    .select("id, kind, status, reason, method, license_status, expires_on, checked_at, jurisdiction")
    .eq("id", checkId as string).maybeSingle();
  return { check: row, processing: claimed.length === 0 && row?.status === "pending" };
}

async function actionResolve(admin: SupabaseClient, caller: Caller, body: Record<string, unknown>) {
  if (!caller.isManager) throw new HttpError(403, "Only a manager can record a manual verification");
  const checkId = asUuid(body.checkId, "checkId");
  const outcome = body.outcome;
  if (outcome !== "verified" && outcome !== "adverse") throw new HttpError(400, "outcome must be verified or adverse");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length < 5) throw new HttpError(400, "A note describing the evidence is required");
  const licenseStatus = (body.licenseStatus ?? null) as LicenseStatus | null;
  if (licenseStatus !== null && !LICENSE_STATUSES.includes(licenseStatus)) throw new HttpError(400, "invalid licenseStatus");

  const { data: source } = await admin.from("verification_checks")
    .select("id, account_owner_id, technician_id, kind, subject_key, credential_id, insurance_policy_id, jurisdiction")
    .eq("id", checkId).maybeSingle();
  if (!source || source.account_owner_id !== caller.ownerId) throw new HttpError(404, "Check not found");

  const kind = source.kind as VerificationKind;
  if (kind === "background") {
    const { data: consent } = await admin.from("background_consents").select("id")
      .eq("technician_id", source.technician_id).is("revoked_at", null).limit(1).maybeSingle();
    if (!consent) throw new HttpError(409, "The technician has not given background-check consent", "consent_missing");
  }

  const { data: newId, error } = await admin.rpc("verification_enqueue_subject", {
    p_owner: caller.ownerId, p_technician: source.technician_id, p_kind: kind, p_credential: source.credential_id,
    p_policy: source.insurance_policy_id, p_jurisdiction: source.jurisdiction, p_requested_by: caller.userId,
  });
  if (error) throw new HttpError(400, error.message);
  const claimed = await claim(admin, 1, newId as string);
  if (!claimed.length) throw new HttpError(409, "This subject is being verified right now. Try again in a minute.");

  const expiresOn = typeof body.expiresOn === "string" && body.expiresOn ? body.expiresOn : null;
  const decision = decisionFromManual(
    { kind, outcome, licenseStatus, expiresOn, note, reference: typeof body.reference === "string" ? body.reference : null },
    toIsoDate(new Date()),
  );
  const result = await finalize(admin, claimed[0], decision, null, "manual", source.jurisdiction as string | null);
  await admin.from("verification_events").insert({
    check_id: claimed[0].id, account_owner_id: caller.ownerId, technician_id: source.technician_id,
    event_type: "manual_resolution", actor_id: caller.userId, payload: { outcome, resolved_from: checkId },
  });
  return { checkId: claimed[0].id, ...result };
}

async function actionSweep(admin: SupabaseClient) {
  const started = Date.now();
  const { data: queued, error } = await admin.rpc("verification_enqueue_due", { p_limit: 200 });
  if (error) throw new Error(`enqueue failed: ${error.message}`);
  let processed = 0;
  while (Date.now() - started < SWEEP_BUDGET_MS) {
    const batch = await claim(admin, SWEEP_BATCH);
    if (batch.length === 0) break;
    await mapPool(batch, CONCURRENCY, (c) => runCheck(admin, c));
    processed += batch.length;
  }
  return { queued: queued ?? 0, processed };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !anonKey || !serviceKey) throw new HttpError(500, "Server is not configured");
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new HttpError(400, "JSON body required");

    const bearer = (req.headers.get("Authorization") ?? "").replace(/^bearer\s+/i, "");
    if (body.action === "sweep") {
      if (!bearer || !safeEqual(bearer, serviceKey)) throw new HttpError(403, "sweep is restricted to the scheduler");
      return json(await actionSweep(admin));
    }

    const caller = await authenticate(req, url, anonKey);
    if (body.action === "request") return json(await actionRequest(admin, caller, body));
    if (body.action === "resolve") return json(await actionResolve(admin, caller, body));
    throw new HttpError(400, "Unknown action");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error("verification-network error", e instanceof Error ? e.message : e);
    return json({ error: "Internal error" }, 500);
  }
});
