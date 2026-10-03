// supabase/functions/adaptive-diagnostics/index.ts
//
// VIREEK Adaptive Diagnostic Network - session orchestrator.
//
// Actions (POST JSON):
//   start  { symptomKey, jobId?, equipmentId?, equipmentLabel?, make?, model? }
//   answer { sessionId, testKey, answerKey }      (answerKey "__skip__" = could not run the test)
//   state  { sessionId }                           (resume / refresh)
//
// No LLM is called: the next question is chosen by the deterministic Bayesian engine in
// _shared/adaptive-diagnostics/engine.ts, so it is fast, free, explainable and testable.
//
// Auth  : caller JWT. The account owner id is resolved with get_account_owner_id() under the
//         caller's identity, every session is checked against it, and job/equipment lookups run
//         as the caller (RLS). The service role is used only for engine reads
//         (adn_load_context) and for writing sessions/steps, so probabilities, outcomes and
//         learned counts cannot be forged from the browser.
// Secrets: none beyond the standard SUPABASE_* ones.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ENGINE_VERSION,
  LAYER_WEIGHTS,
  SKIP_ANSWER,
  analyze,
  confidenceLabel,
  findHazards,
  gainForTest,
  mergeLikelihoodCounts,
  mergePriors,
  type Analysis,
  type AnalyzeInput,
  type CauseDef,
  type LearnedLikelihoodLayer,
  type LearnedPriorLayer,
  type LikelihoodRow,
  type Step,
  type TestDef,
} from "../_shared/adaptive-diagnostics/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9_]{1,64}$/;
const MAX_SESSIONS_PER_HOUR = 60;
const DIFFERENTIAL_SIZE = 8;

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeMake(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toLowerCase().replace(/[^a-z0-9 &.\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

// ---------------------------------------------------------------------------
// Context -> engine input
// ---------------------------------------------------------------------------

interface RawContext {
  symptom: { key: string; label: string; family: string; mandatory_test_keys: string[] };
  causes: { key: string; label: string; safety_critical: boolean }[];
  tests: {
    key: string; label: string; question: string; tool_needed: string | null; effort: number;
    kind: TestDef["kind"]; safety_note: string | null; answers: TestDef["answers"];
  }[];
  seed_priors: { cause_key: string; weight: number }[];
  learned_priors: { scope_user_id: string; make: string; cause_key: string; n: number }[];
  seed_likelihoods: { test_key: string; cause_key: string; answer_key: string; weight: number }[];
  learned_likelihoods: { scope_user_id: string; make: string; cause_key: string; test_key: string; answer_key: string; n: number }[];
}

interface SessionRow {
  id: string; user_id: string; technician_id: string; job_id: string | null; customer_id: string | null;
  equipment_id: string | null; equipment_label: string | null; make: string; model: string | null;
  symptom_key: string; family: string; status: string; step_count: number; posterior: unknown;
  entropy_bits: number | null; stop_reason: string | null; suggested_cause_key: string | null;
  suggested_probability: number | null; confirmed_cause_key: string | null; outcome: string | null;
  needs_review: boolean; verify_due_at: string | null; created_at: string; [k: string]: unknown;
}

interface StepRow {
  step_no: number; test_key: string; answer_key: string; information_gain_bits: number | null;
  entropy_before: number | null; entropy_after: number | null; top_cause_key: string | null; top_probability: number | null;
}

async function loadContext(admin: SupabaseClient, ownerId: string, symptomKey: string, make: string): Promise<RawContext | null> {
  const { data, error } = await admin.rpc("adn_load_context", { p_owner: ownerId, p_symptom_key: symptomKey, p_make: make });
  if (error) throw new Error(`context load failed: ${error.message}`);
  return (data as RawContext | null) ?? null;
}

function buildEngineInput(ctx: RawContext, ownerId: string, make: string, steps: Step[]): AnalyzeInput {
  const priorRows = (scope: string, mk: string) =>
    ctx.learned_priors
      .filter((r) => r.scope_user_id === scope && r.make === mk)
      .map((r) => ({ cause: r.cause_key, n: Number(r.n) }));
  const priorLayers: LearnedPriorLayer[] = [
    { weight: LAYER_WEIGHTS.accountFamily, minSupport: 0, rows: priorRows(ownerId, "") },
    { weight: LAYER_WEIGHTS.networkFamily, minSupport: LAYER_WEIGHTS.networkMinSupport, rows: priorRows(NIL_UUID, "") },
  ];
  if (make) {
    priorLayers.push(
      { weight: LAYER_WEIGHTS.accountMake, minSupport: 0, rows: priorRows(ownerId, make) },
      { weight: LAYER_WEIGHTS.networkMake, minSupport: LAYER_WEIGHTS.networkMinSupport, rows: priorRows(NIL_UUID, make) },
    );
  }
  const seedPrior: Record<string, number> = {};
  for (const r of ctx.seed_priors) seedPrior[r.cause_key] = Number(r.weight);
  const priors = mergePriors(seedPrior, priorLayers, ctx.causes.map((c) => c.key));

  const likRows = (scope: string, mk: string): LikelihoodRow[] =>
    ctx.learned_likelihoods
      .filter((r) => r.scope_user_id === scope && r.make === mk)
      .map((r) => ({ test: r.test_key, cause: r.cause_key, answer: r.answer_key, n: Number(r.n) }));
  const likLayers: LearnedLikelihoodLayer[] = [
    { weight: LAYER_WEIGHTS.accountFamily, minSupport: 0, rows: likRows(ownerId, "") },
    { weight: LAYER_WEIGHTS.networkFamily, minSupport: LAYER_WEIGHTS.networkMinSupport, rows: likRows(NIL_UUID, "") },
  ];
  if (make) {
    likLayers.push(
      { weight: LAYER_WEIGHTS.accountMake, minSupport: 0, rows: likRows(ownerId, make) },
      { weight: LAYER_WEIGHTS.networkMake, minSupport: LAYER_WEIGHTS.networkMinSupport, rows: likRows(NIL_UUID, make) },
    );
  }
  const counts = mergeLikelihoodCounts(
    ctx.seed_likelihoods.map((r) => ({ test: r.test_key, cause: r.cause_key, answer: r.answer_key, n: Number(r.weight) })),
    likLayers,
  );

  const causes: CauseDef[] = ctx.causes.map((c) => ({
    key: c.key, label: c.label, prior: priors[c.key] ?? 0.4, safetyCritical: c.safety_critical,
  }));
  const tests: TestDef[] = ctx.tests.map((t) => ({
    key: t.key, label: t.label, question: t.question, toolNeeded: t.tool_needed, effort: t.effort,
    kind: t.kind, safetyNote: t.safety_note, answers: t.answers,
  }));
  return { causes, tests, counts, steps, mandatoryTestKeys: ctx.symptom.mandatory_test_keys ?? [] };
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

const r4 = (n: number) => Math.round(n * 10000) / 10000;

function diffOut(d: Analysis["differential"]) {
  return d.slice(0, DIFFERENTIAL_SIZE).map((x) => ({
    cause_key: x.causeKey, label: x.label, probability: r4(x.probability), safety_critical: x.safetyCritical,
  }));
}

function buildState(session: SessionRow, stepRows: StepRow[], input: AnalyzeInput, analysis: Analysis | null) {
  const testByKey = new Map(input.tests.map((t) => [t.key, t] as const));
  const causeLabel = new Map(input.causes.map((c) => [c.key, c.label] as const));
  const steps = stepRows.map((s) => {
    const t = testByKey.get(s.test_key);
    return {
      step_no: s.step_no,
      test_key: s.test_key,
      test_label: t?.label ?? s.test_key,
      answer_key: s.answer_key,
      answer_label: s.answer_key === SKIP_ANSWER ? "Skipped (could not test)" : t?.answers.find((a) => a.key === s.answer_key)?.label ?? s.answer_key,
      information_gain_bits: s.information_gain_bits,
      entropy_before: s.entropy_before,
      entropy_after: s.entropy_after,
      top_cause_key: s.top_cause_key,
      top_cause_label: s.top_cause_key ? causeLabel.get(s.top_cause_key) ?? s.top_cause_key : null,
      top_probability: s.top_probability,
    };
  });

  let decision;
  if (analysis && session.status === "active") {
    decision = {
      action: analysis.action,
      stop_reason: analysis.stopReason,
      confidence: analysis.confidence,
      entropy_bits: r4(analysis.entropyBits),
      answered_count: analysis.answeredCount,
      differential: diffOut(analysis.differential),
      safety_alerts: analysis.safetyAlerts.map((s) => ({ cause_key: s.causeKey, label: s.label, probability: r4(s.probability) })),
      hazards: analysis.hazards.map((h) => ({ test_key: h.testKey, answer_key: h.answerKey, answer_label: h.answerLabel })),
      next: analysis.next && {
        test: {
          key: analysis.next.test.key, label: analysis.next.test.label, question: analysis.next.test.question,
          tool_needed: analysis.next.test.toolNeeded, effort: analysis.next.test.effort, kind: analysis.next.test.kind,
          safety_note: analysis.next.test.safetyNote, answers: analysis.next.test.answers,
        },
        information_gain_bits: r4(analysis.next.informationGainBits),
        reason: analysis.next.reason,
        preview: analysis.next.preview.map((p) => ({
          answer_key: p.answerKey, answer_label: p.answerLabel, probability: r4(p.probability),
          top_cause_key: p.topCauseKey, top_cause_label: p.topCauseLabel, top_cause_probability: r4(p.topCauseProbability),
        })),
      },
    };
  } else {
    // Concluded sessions are shown from the frozen posterior so history never drifts.
    const frozen = (Array.isArray(session.posterior) ? session.posterior : []) as {
      cause_key: string; label: string; probability: number; safety_critical: boolean;
    }[];
    const hazards = findHazards(input.tests, input.steps ?? []);
    decision = {
      action: "conclude" as const,
      stop_reason: session.stop_reason,
      confidence: confidenceLabel(frozen[0]?.probability ?? 0),
      entropy_bits: session.entropy_bits,
      answered_count: stepRows.filter((s) => s.answer_key !== SKIP_ANSWER).length,
      differential: frozen,
      safety_alerts: frozen.filter((d) => d.safety_critical && d.probability >= 0.08)
        .map((d) => ({ cause_key: d.cause_key, label: d.label, probability: d.probability })),
      hazards: hazards.map((h) => ({ test_key: h.testKey, answer_key: h.answerKey, answer_label: h.answerLabel })),
      next: null,
    };
  }

  return {
    session: {
      id: session.id, status: session.status, symptom_key: session.symptom_key, family: session.family,
      make: session.make, model: session.model, equipment_label: session.equipment_label, job_id: session.job_id,
      step_count: session.step_count, suggested_cause_key: session.suggested_cause_key,
      suggested_probability: session.suggested_probability, confirmed_cause_key: session.confirmed_cause_key,
      outcome: session.outcome, needs_review: session.needs_review, verify_due_at: session.verify_due_at,
      created_at: session.created_at,
    },
    steps,
    decision,
  };
}

async function persistAnalysis(admin: SupabaseClient, session: SessionRow, stepCount: number, a: Analysis): Promise<SessionRow> {
  const patch: Record<string, unknown> = {
    step_count: stepCount,
    posterior: diffOut(a.differential),
    entropy_bits: r4(a.entropyBits),
    engine_version: ENGINE_VERSION,
    updated_at: new Date().toISOString(),
  };
  if (a.action === "conclude" && session.status === "active") {
    patch.status = "diagnosed";
    patch.stop_reason = a.stopReason;
    patch.suggested_cause_key = a.differential[0]?.causeKey ?? null;
    patch.suggested_probability = a.differential[0] ? r4(a.differential[0].probability) : null;
    patch.concluded_at = new Date().toISOString();
  }
  const { data, error } = await admin.from("adn_sessions").update(patch).eq("id", session.id).select("*").single();
  if (error) throw new Error(`session update failed: ${error.message}`);
  return data as SessionRow;
}

async function loadSession(admin: SupabaseClient, ownerId: string, sessionId: unknown): Promise<SessionRow> {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) throw new HttpError(400, "Invalid session id.");
  const { data, error } = await admin.from("adn_sessions").select("*").eq("id", sessionId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || (data as SessionRow).user_id !== ownerId) throw new HttpError(404, "Diagnostic session not found.");
  return data as SessionRow;
}

async function loadSteps(admin: SupabaseClient, sessionId: string): Promise<StepRow[]> {
  const { data, error } = await admin
    .from("adn_session_steps")
    .select("step_no, test_key, answer_key, information_gain_bits, entropy_before, entropy_after, top_cause_key, top_probability")
    .eq("session_id", sessionId)
    .order("step_no", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as StepRow[]) ?? [];
}

const toSteps = (rows: StepRow[]): Step[] => rows.map((r) => ({ testKey: r.test_key, answerKey: r.answer_key }));

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStart(
  body: Record<string, unknown>, user: { id: string }, ownerId: string,
  callerClient: SupabaseClient, admin: SupabaseClient,
) {
  const symptomKey = typeof body.symptomKey === "string" ? body.symptomKey : "";
  if (!KEY_RE.test(symptomKey)) throw new HttpError(400, "Choose a symptom to start.");

  let make = normalizeMake(body.make);
  let model = typeof body.model === "string" ? body.model.trim().slice(0, 80) : "";
  let equipmentLabel = typeof body.equipmentLabel === "string" ? body.equipmentLabel.trim().slice(0, 200) : "";

  let jobId: string | null = null;
  let customerId: string | null = null;
  if (typeof body.jobId === "string" && UUID_RE.test(body.jobId)) {
    const { data: job } = await callerClient.from("jobs").select("id, customer_id").eq("id", body.jobId).maybeSingle();
    if (job) { jobId = job.id as string; customerId = (job.customer_id as string | null) ?? null; }
  }
  let equipmentId: string | null = null;
  if (typeof body.equipmentId === "string" && UUID_RE.test(body.equipmentId)) {
    const { data: eq } = await callerClient
      .from("equipment").select("id, equipment_type, make, model, serial_number").eq("id", body.equipmentId).maybeSingle();
    if (eq) {
      equipmentId = eq.id as string;
      make = make || normalizeMake(eq.make);
      model = model || ((eq.model as string | null) ?? "");
      equipmentLabel = equipmentLabel ||
        [eq.equipment_type, eq.make, eq.model].filter(Boolean).join(" ");
    }
  }

  const ctx = await loadContext(admin, ownerId, symptomKey, make);
  if (!ctx) throw new HttpError(400, "Unknown symptom.");

  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("adn_sessions").select("id", { count: "exact", head: true })
    .eq("technician_id", user.id).gte("created_at", since);
  if ((count ?? 0) >= MAX_SESSIONS_PER_HOUR) throw new HttpError(429, "Too many diagnostic sessions started this hour. Try again shortly.");

  const { data: created, error: insErr } = await admin.from("adn_sessions").insert({
    user_id: ownerId, technician_id: user.id, job_id: jobId, customer_id: customerId, equipment_id: equipmentId,
    equipment_label: equipmentLabel || null, make, model: model || null, symptom_key: symptomKey,
    family: ctx.symptom.family, engine_version: ENGINE_VERSION,
  }).select("*").single();
  if (insErr || !created) throw new Error(`session create failed: ${insErr?.message}`);

  const input = buildEngineInput(ctx, ownerId, make, []);
  const analysis = analyze(input);
  const session = await persistAnalysis(admin, created as SessionRow, 0, analysis);
  return buildState(session, [], input, analysis);
}

async function handleAnswer(body: Record<string, unknown>, ownerId: string, admin: SupabaseClient) {
  const session = await loadSession(admin, ownerId, body.sessionId);
  const testKey = typeof body.testKey === "string" ? body.testKey : "";
  const answerKey = typeof body.answerKey === "string" ? body.answerKey : "";
  if (!KEY_RE.test(testKey) || !(KEY_RE.test(answerKey) || answerKey === SKIP_ANSWER)) throw new HttpError(400, "Invalid answer.");
  if (session.status !== "active") throw new HttpError(409, "This session is already concluded.", "session_not_active");

  const ctx = await loadContext(admin, ownerId, session.symptom_key, session.make);
  if (!ctx) throw new HttpError(400, "Unknown symptom.");
  const existing = await loadSteps(admin, session.id);
  const steps = toSteps(existing);
  const baseInput = buildEngineInput(ctx, ownerId, session.make, steps);

  const test = baseInput.tests.find((t) => t.key === testKey);
  if (!test) throw new HttpError(400, "That test does not apply to this diagnosis.");
  if (steps.some((s) => s.testKey === testKey)) throw new HttpError(409, "That test was already answered.", "duplicate_step");
  if (answerKey !== SKIP_ANSWER && !test.answers.some((a) => a.key === answerKey)) throw new HttpError(400, "Invalid answer for this test.");

  const before = analyze(baseInput);
  const gain = gainForTest(baseInput, testKey);
  const newSteps: Step[] = [...steps, { testKey, answerKey }];
  const afterInput: AnalyzeInput = { ...baseInput, steps: newSteps };
  const after = analyze(afterInput);

  const { error: stepErr } = await admin.from("adn_session_steps").insert({
    session_id: session.id, user_id: ownerId, step_no: existing.length + 1, test_key: testKey, answer_key: answerKey,
    information_gain_bits: r4(gain), entropy_before: r4(before.entropyBits), entropy_after: r4(after.entropyBits),
    top_cause_key: after.differential[0]?.causeKey ?? null,
    top_probability: after.differential[0] ? r4(after.differential[0].probability) : null,
  });
  if (stepErr) {
    if (stepErr.code === "23505") throw new HttpError(409, "Another device answered this step first. Refresh to continue.", "duplicate_step");
    throw new Error(`step insert failed: ${stepErr.message}`);
  }

  const updated = await persistAnalysis(admin, session, newSteps.length, after);
  const rows = await loadSteps(admin, session.id);
  return buildState(updated, rows, afterInput, after);
}

async function handleState(body: Record<string, unknown>, ownerId: string, admin: SupabaseClient) {
  const session = await loadSession(admin, ownerId, body.sessionId);
  const ctx = await loadContext(admin, ownerId, session.symptom_key, session.make);
  if (!ctx) throw new HttpError(400, "Unknown symptom.");
  const rows = await loadSteps(admin, session.id);
  const input = buildEngineInput(ctx, ownerId, session.make, toSteps(rows));
  if (session.status === "active") {
    const analysis = analyze(input);
    // Keep the stored snapshot fresh while the session is still open.
    const updated = await persistAnalysis(admin, session, rows.length, analysis);
    return buildState(updated, rows, input, analysis);
  }
  return buildState(session, rows, input, null);
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid request body." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: ownerId, error: ownerErr } = await callerClient.rpc("get_account_owner_id");
    if (ownerErr || typeof ownerId !== "string") return json({ error: "Could not resolve your account." }, 403);

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const action = (body as Record<string, unknown>).action;
    if (action === "start") return json(await handleStart(body as Record<string, unknown>, user, ownerId, callerClient, admin));
    if (action === "answer") return json(await handleAnswer(body as Record<string, unknown>, ownerId, admin));
    if (action === "state") return json(await handleState(body as Record<string, unknown>, ownerId, admin));
    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, code: err.code ?? null }, err.status);
    console.error("[adaptive-diagnostics] unhandled error", err);
    return json({ error: "Something went wrong running the diagnostic." }, 500);
  }
});
