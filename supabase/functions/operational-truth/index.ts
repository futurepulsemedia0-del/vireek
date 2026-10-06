// supabase/functions/operational-truth/index.ts
//
// Vireek Operational Truth Engine — API.
//
//   JWT callers (dashboard):
//     overview          read the trust posture of the account (any team member)
//     gate              ask "may an agent act on this fact?" (any team member; audited)
//     assert            record a claim from a USER-assertable source   (needs can_manage_team)
//     verify            confirm / reject a claim                        (needs can_manage_team)
//     resolve_conflict  pick the winning claim of an open conflict      (needs can_manage_team)
//
//   Service-role callers (agents, connectors, cron) — Authorization: Bearer <service role key>:
//     gate              + userId       agents ask before acting
//     ingest            + userId       record a claim from ANY catalog source (authorities)
//     sweep             [+ userId]     open/close conflicts, send expiry alerts
//
// Security model
//   - Identity comes from the caller's own JWT; the account is derived server-side, never from the body.
//   - Authoritative sources (state license DB, manufacturer portal, ...) can only be written by the
//     service role, so a user can never forge "verified by the State License DB".
//   - Authoritative claims cannot be re-stamped fresh by a human click; their integration must re-verify.
//   - All writes are atomic SQL functions executable only by service_role.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  computeBaseConfidence,
  getSource,
  isUserAssertable,
  normalizeAssertion,
  resolvePolicy,
  resolveTruth,
  SOURCE_CATALOG,
  type TruthFact,
  type TruthPolicy,
  type TruthResolution,
  type TruthVerdict,
} from "../_shared/truth/engine.ts";
import {
  evaluateTruth,
  FACT_COLUMNS,
  loadPolicies,
  requireFreshTruth,
  syncConflict,
  toFact,
  type FactRow,
} from "../_shared/truth/gate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const MAX_FACTS = 5000;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Ctx {
  ownerId: string;
  actorId: string | null;
  canManage: boolean;
  service: boolean;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function authenticate(req: Request, body: Record<string, unknown>, admin: SupabaseClient, serviceKey: string): Promise<Ctx> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Missing Authorization header.");

  if (serviceKey && safeEqual(token, serviceKey)) {
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!UUID_RE.test(userId)) throw new HttpError(400, "userId is required for service calls.");
    return { ownerId: userId, actorId: null, canManage: true, service: true };
  }

  const { data: userData, error } = await admin.auth.getUser(token);
  if (error || !userData?.user) throw new HttpError(401, "Invalid or expired session.");
  const user = userData.user;

  const { data: profile } = await admin.from("profiles").select("id, role").eq("id", user.id).maybeSingle();
  if (profile && profile.role === "owner") return { ownerId: user.id, actorId: user.id, canManage: true, service: false };

  const emails = Array.from(new Set([user.email ?? "", (user.email ?? "").toLowerCase()].filter(Boolean)));
  if (emails.length > 0) {
    const { data: tm } = await admin
      .from("team_members")
      .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
      .in("member_email", emails)
      .limit(1)
      .maybeSingle();
    if (tm?.account_owner_id) {
      const base = (tm.permissions ?? {}) as Record<string, unknown>;
      const role = (tm as unknown as { custom_role?: { permissions?: Record<string, unknown> } | null }).custom_role?.permissions ?? {};
      return { ownerId: tm.account_owner_id as string, actorId: user.id, canManage: { ...base, ...role }.can_manage_team === true, service: false };
    }
  }
  if (profile) return { ownerId: user.id, actorId: user.id, canManage: false, service: false };
  throw new HttpError(403, "No account found for this user.");
}

function requireManage(ctx: Ctx) {
  if (!ctx.canManage) throw new HttpError(403, "You need the team-management permission to change operational truth.");
}

function groupKey(f: { subject_type: string; subject_id: string; predicate: string }): string {
  return `${f.subject_type}\u0000${f.subject_id}\u0000${f.predicate}`;
}

function groupFacts<T extends TruthFact>(facts: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const f of facts) {
    const k = groupKey(f);
    const arr = m.get(k);
    if (arr) arr.push(f);
    else m.set(k, [f]);
  }
  return m;
}

async function loadAllFacts(admin: SupabaseClient, userId: string): Promise<Array<TruthFact & { expiry_alert_stage: string | null }>> {
  const { data, error } = await admin
    .from("truth_facts")
    .select(`${FACT_COLUMNS}, expiry_alert_stage`)
    .eq("user_id", userId)
    .eq("status", "current")
    .order("created_at", { ascending: false })
    .limit(MAX_FACTS);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<FactRow & { expiry_alert_stage: string | null }>).map((r) => ({
    ...toFact(r),
    expiry_alert_stage: r.expiry_alert_stage ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function writeClaim(admin: SupabaseClient, ctx: Ctx, raw: unknown, allowAnySource: boolean) {
  requireManage(ctx);
  const norm = normalizeAssertion(raw);
  if (!norm.ok) throw new HttpError(400, norm.error);
  const a = norm.value;
  if (!allowAnySource && !isUserAssertable(a.source_key)) {
    throw new HttpError(403, `${getSource(a.source_key).label} can only be recorded by a verified integration.`);
  }
  const confidence = computeBaseConfidence(a.source_key, a.evidence.length, a.confidence_cap);
  const { data, error } = await admin.rpc("truth_write_claim", {
    p_user: ctx.ownerId,
    p_actor: ctx.actorId,
    p_subject_type: a.subject_type,
    p_subject_id: a.subject_id,
    p_predicate: a.predicate,
    p_value: a.value,
    p_source_key: a.source_key,
    p_source_ref: a.source_ref,
    p_verified_at: a.verified_at,
    p_expires_at: a.expires_at,
    p_confidence: confidence,
    p_method: a.method,
    p_evidence: a.evidence,
  });
  if (error) throw error;

  // Return the fresh resolution so the caller sees the effect of the new claim immediately
  // (evaluation only — this is not an agent decision, so no audit row is written).
  const q = { subject_type: a.subject_type, subject_id: a.subject_id, predicate: a.predicate };
  const res = await evaluateTruth(admin, ctx.ownerId, q);
  await syncConflict(admin, ctx.ownerId, q, res);
  return { factId: data as string, confidence, resolution: res };
}

async function verifyClaim(admin: SupabaseClient, ctx: Ctx, body: Record<string, unknown>) {
  requireManage(ctx);
  const factId = typeof body.factId === "string" ? body.factId : "";
  const result = body.result;
  if (!UUID_RE.test(factId)) throw new HttpError(400, "Invalid factId.");
  if (result !== "confirmed" && result !== "rejected") throw new HttpError(400, "result must be 'confirmed' or 'rejected'.");

  const { data: fact } = await admin
    .from("truth_facts")
    .select("id, source_key, subject_type, subject_id, predicate")
    .eq("id", factId)
    .eq("user_id", ctx.ownerId)
    .maybeSingle();
  if (!fact) throw new HttpError(404, "Claim not found.");
  if (result === "confirmed" && getSource(fact.source_key as string).authoritative && !ctx.service) {
    throw new HttpError(403, "Authoritative records are re-verified by their integration, not by a manual confirmation.");
  }

  let newExpires: string | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null && body.expires_at !== "") {
    const ms = Date.parse(String(body.expires_at));
    if (!Number.isFinite(ms) || ms <= Date.now()) throw new HttpError(400, "expires_at must be a future date.");
    if (ms > Date.now() + 3650 * DAY_MS) throw new HttpError(400, "expires_at is too far in the future.");
    newExpires = new Date(ms).toISOString();
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  const { data, error } = await admin.rpc("truth_verify_claim", {
    p_user: ctx.ownerId,
    p_actor: ctx.actorId,
    p_fact: factId,
    p_result: result,
    p_new_expires: newExpires,
    p_note: note,
  });
  if (error) throw error;

  const q = { subject_type: fact.subject_type as string, subject_id: fact.subject_id as string, predicate: fact.predicate as string };
  const res = await evaluateTruth(admin, ctx.ownerId, q);
  await syncConflict(admin, ctx.ownerId, q, res);
  return { result: data, resolution: res };
}

async function resolveConflict(admin: SupabaseClient, ctx: Ctx, body: Record<string, unknown>) {
  requireManage(ctx);
  const conflictId = typeof body.conflictId === "string" ? body.conflictId : "";
  const winner = typeof body.winningFactId === "string" ? body.winningFactId : "";
  if (!UUID_RE.test(conflictId) || !UUID_RE.test(winner)) throw new HttpError(400, "Invalid conflictId or winningFactId.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;
  const { data, error } = await admin.rpc("truth_resolve_conflict", {
    p_user: ctx.ownerId,
    p_actor: ctx.actorId,
    p_conflict: conflictId,
    p_winner: winner,
    p_note: note,
  });
  if (error) throw error;
  return { result: data };
}

async function gate(admin: SupabaseClient, ctx: Ctx, body: Record<string, unknown>) {
  const q = {
    subject_type: String(body.subject_type ?? ""),
    subject_id: String(body.subject_id ?? ""),
    predicate: String(body.predicate ?? ""),
    expected: body.expected === undefined ? true : body.expected,
  };
  const probe = normalizeAssertion({ ...q, source_key: "owner_entered" });
  if (!probe.ok) throw new HttpError(400, probe.error);
  const agent = typeof body.agent === "string" && body.agent.trim() ? body.agent.trim().slice(0, 80) : ctx.service ? "service" : "dashboard";
  return { resolution: await requireFreshTruth(admin, ctx.ownerId, agent, q) };
}

const SEVERITY: Record<TruthVerdict, number> = {
  conflict: 0, expired: 1, stale: 2, unverified: 3, low_confidence: 4, insufficient_corroboration: 5, denied: 6, verified: 7,
};

async function technicianNames(admin: SupabaseClient, subjectIds: string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(subjectIds.filter((s) => UUID_RE.test(s))));
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from("team_members").select("id, member_name").in("id", ids.slice(i, i + 100));
    for (const t of data ?? []) if (t.member_name) names.set(t.id as string, t.member_name as string);
  }
  return names;
}

async function overview(admin: SupabaseClient, ctx: Ctx) {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const [facts, policies, decisionsRes, blockedRes] = await Promise.all([
    loadAllFacts(admin, ctx.ownerId),
    loadPolicies(admin, ctx.ownerId),
    admin.from("truth_decisions").select("allow").eq("user_id", ctx.ownerId).gte("created_at", since).limit(5000),
    admin.from("truth_decisions").select("id, agent, subject_type, subject_id, predicate, verdict, reason, created_at").eq("user_id", ctx.ownerId).eq("allow", false).order("created_at", { ascending: false }).limit(10),
  ]);

  const grouped = groupFacts(facts);
  const byVerdict: Record<string, number> = {};
  let expiringSoon = 0;
  const rows: Array<{ res: TruthResolution; facts: typeof facts }> = [];
  for (const [, list] of grouped) {
    const res = resolveTruth(list, resolvePolicy(list[0].predicate, policies), { now });
    byVerdict[res.verdict] = (byVerdict[res.verdict] ?? 0) + 1;
    if (res.allow && res.warnings.some((w) => w.startsWith("Expires"))) expiringSoon++;
    rows.push({ res, facts: list });
  }

  // Make sure every conflict the engine currently sees has a row the owner can resolve.
  await Promise.all(
    rows
      .filter((r) => r.res.verdict === "conflict")
      .slice(0, 50)
      .map((r) => syncConflict(admin, ctx.ownerId, { subject_type: r.facts[0].subject_type, subject_id: r.facts[0].subject_id, predicate: r.facts[0].predicate }, r.res)),
  );
  const conflictsRes = await admin
    .from("truth_conflicts")
    .select("id, subject_type, subject_id, predicate, fact_ids, opened_at")
    .eq("user_id", ctx.ownerId)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(50);

  const attention = rows
    .filter((r) => !r.res.allow || r.res.warnings.length > 0)
    .sort((a, b) => SEVERITY[a.res.verdict] - SEVERITY[b.res.verdict] || b.res.warnings.length - a.res.warnings.length);

  const shown = attention.slice(0, 150);
  const names = await technicianNames(admin, [
    ...shown.map((r) => r.facts[0].subject_id),
    ...(conflictsRes.data ?? []).map((c) => c.subject_id as string),
    ...(blockedRes.data ?? []).map((d) => d.subject_id as string),
  ]);
  const label = (type: string, id: string) => (type === "technician" ? names.get(id) ?? id : id);

  const decisions = decisionsRes.data ?? [];
  return {
    now: now.toISOString(),
    truncated: facts.length >= MAX_FACTS,
    summary: {
      claims: facts.length,
      facts_tracked: grouped.size,
      verified: byVerdict.verified ?? 0,
      needs_attention: attention.filter((r) => !r.res.allow).length,
      expiring_soon: expiringSoon,
      open_conflicts: (conflictsRes.data ?? []).length,
      by_verdict: byVerdict,
      decisions_7d: decisions.length,
      blocked_7d: decisions.filter((d) => d.allow === false).length,
    },
    items: shown.map(({ res, facts: list }) => {
      const first = list[0];
      return {
        subject_type: first.subject_type,
        subject_id: first.subject_id,
        subject_label: label(first.subject_type, first.subject_id),
        predicate: first.predicate,
        verdict: res.verdict,
        allow: res.allow,
        confidence: res.confidence,
        reason: res.reason,
        required_action: res.required_action,
        warnings: res.warnings,
        policy: res.policy,
        claims: list.map((f) => {
          const a = res.assessments.find((x) => x.fact_id === f.id);
          return {
            id: f.id,
            value: f.value,
            source_key: f.source_key,
            source_label: getSource(f.source_key).label,
            authoritative: getSource(f.source_key).authoritative,
            verified_at: f.verified_at,
            expires_at: f.expires_at,
            evidence_count: f.evidence_count,
            state: a?.state ?? "stale",
            effective_confidence: a?.effective_confidence ?? 0,
          };
        }),
      };
    }),
    conflicts: (conflictsRes.data ?? []).map((c) => ({ ...c, subject_label: label(c.subject_type as string, c.subject_id as string) })),
    recent_blocked: (blockedRes.data ?? []).map((d) => ({ ...d, subject_label: label(d.subject_type as string, d.subject_id as string) })),
    sources: Object.values(SOURCE_CATALOG).map((s) => ({ key: s.key, label: s.label, kind: s.kind, reliability: s.reliability, authoritative: s.authoritative, user_assertable: s.userAssertable })),
  };
}

async function sweep(admin: SupabaseClient, onlyUser: string | null) {
  let userQuery = admin.from("truth_facts").select("user_id").eq("status", "current").limit(50_000);
  if (onlyUser) userQuery = userQuery.eq("user_id", onlyUser);
  const { data: userRows, error } = await userQuery;
  if (error) throw error;
  const users = Array.from(new Set((userRows ?? []).map((r) => r.user_id as string))).slice(0, 500);

  const stats = { accounts: users.length, facts_tracked: 0, conflicts: 0, alerts: 0 };
  const now = new Date();
  for (const userId of users) {
    try {
      const [facts, policies] = await Promise.all([loadAllFacts(admin, userId), loadPolicies(admin, userId)]);
      let alertsForUser = 0;
      for (const [, list] of groupFacts(facts)) {
        stats.facts_tracked++;
        const policy: TruthPolicy = resolvePolicy(list[0].predicate, policies);
        const res = resolveTruth(list, policy, { now });
        const q = { subject_type: list[0].subject_type, subject_id: list[0].subject_id, predicate: list[0].predicate };
        await syncConflict(admin, userId, q, res);
        if (res.verdict === "conflict") stats.conflicts++;

        for (const f of list) {
          if (!f.expires_at || alertsForUser >= 25) continue;
          const days = (Date.parse(f.expires_at) - now.getTime()) / DAY_MS;
          const stage = days <= 0 ? "expired" : policy.expiring_warning_days > 0 && days <= policy.expiring_warning_days ? "expiring_soon" : null;
          if (!stage || stage === f.expiry_alert_stage) continue;
          if (stage === "expired" && res.allow) continue; // a redundant claim lapsed; the fact still stands
          const what = `${f.predicate} for ${f.subject_type} ${f.subject_id}`;
          const { error: nErr } = await admin.from("notifications").insert({
            user_id: userId,
            type: "ai_insight",
            title: stage === "expired" ? "Verified fact expired" : "Verified fact expiring soon",
            message: stage === "expired"
              ? `The record behind ${what} has expired — agents will not act on it until it is re-verified.`
              : `The record behind ${what} expires in ${Math.max(1, Math.ceil(days))} day(s). Re-verify it to keep agents unblocked.`,
            action_url: "/dashboard/operational-truth",
          });
          if (nErr) continue;
          await admin.from("truth_facts").update({ expiry_alert_stage: stage }).eq("id", f.id);
          alertsForUser++;
          stats.alerts++;
        }
      }
    } catch (err) {
      console.error("truth sweep failed for one account", err instanceof Error ? err.message : err);
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body." }, 400);

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, { auth: { persistSession: false } });
    const action = typeof body.action === "string" ? body.action : "";

    // Sweep may run for all accounts, so it is the one action that doesn't need a userId.
    if (action === "sweep") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!serviceKey || !safeEqual(token, serviceKey)) return json({ error: "Service role required." }, 403);
      const only = typeof body.userId === "string" && UUID_RE.test(body.userId) ? body.userId : null;
      return json({ stats: await sweep(admin, only) });
    }

    const ctx = await authenticate(req, body, admin, serviceKey);
    switch (action) {
      case "overview":
        return json(await overview(admin, ctx));
      case "gate":
        return json(await gate(admin, ctx, body));
      case "assert":
        return json(await writeClaim(admin, ctx, body.assertion ?? body, false));
      case "ingest":
        if (!ctx.service) throw new HttpError(403, "ingest is restricted to verified integrations.");
        return json(await writeClaim(admin, ctx, body.assertion ?? body, true));
      case "verify":
        return json(await verifyClaim(admin, ctx, body));
      case "resolve_conflict":
        return json(await resolveConflict(admin, ctx, body));
      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    const e = err as { code?: string; message?: string };
    // RAISE EXCEPTION from our SQL functions carries SQLSTATE P0001 and a safe, human message.
    if (e?.code === "P0001" && e.message) return json({ error: e.message }, 400);
    console.error("operational-truth error", e?.message ?? err);
    return json({ error: "Internal error." }, 500);
  }
});
