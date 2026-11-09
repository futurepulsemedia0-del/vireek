// dispatch-optimizer — server-side compute for the Smart Dispatch Optimizer (suggestions only).
//
// Gate: dispatch_optimizer_access() evaluated AS THE CALLER (anon key + caller JWT). It checks the
// feature flag, the per-account entitlement and that the caller may manage jobs; the account owner
// id comes from the database, never from the request. Every job/technician id in the payload is
// verified to belong to that account with owner-scoped service-role queries. Settings (weights,
// overtime cap, seed, policies) are read from the database and override anything the client sent.
// Nothing is written except an append-only audit row (counts and ids only).
//
// POST { action: 'optimize' | 'what_if' | 'emergency', input: OptInput-without-config,
//        scenario?: Scenario, event?: { jobId, expectedEndMs }, scope?: 'affected'|'all' }

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildSuggestions } from "../../../src/lib/dispatchOptimizer/suggestions.ts";
import { simulate, type Scenario } from "../../../src/lib/dispatchOptimizer/whatif.ts";
import { reoptimizeForLateJob } from "../../../src/lib/dispatchOptimizer/emergency.ts";
import type { OptInput } from "../../../src/lib/dispatchOptimizer/types.ts";

const MAX_JOBS = 400;
const MAX_TECHS = 100;
const MAX_BODY_BYTES = 2_000_000;
// Keeps 200 jobs × 50 technicians comfortably under ~2 s; a wall-clock valve guards slow hosts.
const TIME_BUDGET_MS = 1500;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

interface Access {
  allowed: boolean;
  flag_on: boolean;
  entitled: boolean;
  can_manage: boolean;
  owner_id: string;
  settings: {
    weights: { revenue: number; travel: number; slaRisk: number; overtimeFairness: number };
    maxOvertimeMin: number;
    partsPolicy: "soft" | "hard";
    slaHard: boolean;
    seed: number;
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header." }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  // ---- gate (fails closed) --------------------------------------------------
  const { data: accessData, error: accessErr } = await caller.rpc("dispatch_optimizer_access");
  if (accessErr) return json({ error: "Could not verify access." }, 500);
  const access = accessData as Access | null;
  if (!access || access.allowed !== true || !isUuid(access.owner_id)) return json({ error: "Smart dispatch is not available for this account." }, 403);
  const ownerId = access.owner_id;

  // ---- body -----------------------------------------------------------------
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413);
  let body: { action?: string; input?: OptInput; scenario?: Scenario; event?: { jobId?: string; expectedEndMs?: number }; scope?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }
  const input = body.input;
  if (!input || !Array.isArray(input.jobs) || !Array.isArray(input.techs) || !Number.isFinite(input.nowMs)) return json({ error: "Invalid input." }, 400);
  if (input.jobs.length > MAX_JOBS || input.techs.length > MAX_TECHS) return json({ error: `Too many rows (max ${MAX_JOBS} jobs, ${MAX_TECHS} technicians).` }, 413);

  // ---- tenant isolation: every id must belong to this account -------------------
  const jobIds = input.jobs.map((j) => j.id);
  const techIds = input.techs.map((t) => t.id);
  if (![...jobIds, ...techIds].every(isUuid)) return json({ error: "Invalid ids." }, 400);

  const [jobsRes, techRes] = await Promise.all([
    jobIds.length ? admin.from("jobs").select("id").eq("user_id", ownerId).in("id", jobIds) : Promise.resolve({ data: [], error: null }),
    techIds.length ? admin.from("team_members").select("id").eq("account_owner_id", ownerId).in("id", techIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (jobsRes.error || techRes.error) return json({ error: "Could not verify the data." }, 500);
  const okJobs = new Set((jobsRes.data ?? []).map((r: { id: string }) => r.id));
  const okTechs = new Set((techRes.data ?? []).map((r: { id: string }) => r.id));
  if (jobIds.some((id) => !okJobs.has(id)) || techIds.some((id) => !okTechs.has(id))) {
    return json({ error: "Some jobs or technicians do not belong to this account." }, 403);
  }
  // assigned technician references must also stay inside the account
  for (const j of input.jobs) {
    if (j.current?.techId && !okTechs.has(j.current.techId)) j.current = { techId: null, startMs: null };
  }

  // ---- authoritative settings (client config is ignored) -----------------------------
  const s = access.settings;
  const trusted: OptInput = {
    ...input,
    travel: undefined,
    techs: input.techs.map((t) => ({ ...t, maxOvertimeMin: s.maxOvertimeMin })),
    config: { seed: s.seed, weights: s.weights, partsPolicy: s.partsPolicy, slaHard: s.slaHard, timeBudgetMs: TIME_BUDGET_MS },
  };

  const t0 = Date.now();
  try {
    let payload: Record<string, unknown>;
    let action: "optimize" | "what_if" | "emergency";
    let count = 0;
    let truncated = false;
    if (body.action === "what_if" && body.scenario) {
      action = "what_if";
      const sc = body.scenario;
      const r = simulate(trusted, sc);
      payload = { ok: true, whatIf: r };
      count = r.changed.length;
    } else if (body.action === "emergency" && body.event?.jobId && Number.isFinite(body.event.expectedEndMs)) {
      action = "emergency";
      const r = reoptimizeForLateJob(trusted, { jobId: body.event.jobId, expectedEndMs: Number(body.event.expectedEndMs) }, { scope: body.scope === "all" ? "all" : "affected" });
      payload = { ok: r.ok, emergency: r };
      count = r.suggestions.length;
    } else if (body.action === "optimize" || !body.action) {
      action = "optimize";
      const set = buildSuggestions(trusted);
      truncated = set.result.truncatedByTime;
      // the full plan is not returned (smaller payload, and only individually-safe moves are actionable)
      payload = { ok: true, before: set.before, after: set.after, suggestions: set.suggestions, bundleOnlyCount: set.bundleOnlyCount, unplaced: set.result.unplaced, unmodeledFixed: set.result.unmodeledFixed, cost: set.result.cost, engineVersion: set.result.engineVersion, seed: set.result.seed, truncatedByTime: truncated };
      count = set.suggestions.length;
    } else {
      return json({ error: "Unknown action." }, 400);
    }
    const ms = Date.now() - t0;

    // audit is best-effort: a logging failure must not hide a result
    try {
      await admin.from("dispatch_optimizer_audit").insert({
        user_id: ownerId,
        actor_id: null,
        action,
        engine_version: "1.0.0",
        seed: s.seed,
        job_count: trusted.jobs.length,
        tech_count: trusted.techs.length,
        suggestion_count: count,
        duration_ms: ms,
        truncated,
        detail: { source: "edge" },
      });
    } catch { /* ignore */ }

    return json({ ...payload, durationMs: ms, travelSource: "offline_estimate" });
  } catch (e) {
    console.error("dispatch-optimizer failed", e instanceof Error ? e.message : "unknown");
    return json({ error: "The optimizer could not complete. Nothing was changed." }, 500);
  }
});
