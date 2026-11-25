// supabase/functions/rr-certify/index.ts
//
// Owner-facing API for the RRE risk-control layer. POST { action: "status" | "recalibrate" | "report" }.
// Auth: the caller's JWT must belong to the ACCOUNT OWNER (get_account_owner_id() === auth user).
// Never changes live behaviour: it only reads outcomes and writes immutable snapshots / drift state.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  buildShadowReport, buildSnapshot, DEFAULT_CERTIFY_SETTINGS, DEFAULT_DRIFT_CONFIG, driftReference, evaluateDrift, guaranteeView, labelCase, segmentKey,
  type CalibrationSnapshot, type CaseOutcomeRow, type CertifySettings, type DriftObservation, type ShadowRow,
} from "../../../src/lib/rrCertify/index.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: ownerId } = await caller.rpc("get_account_owner_id");
    if (!ownerId || ownerId !== user.id) return json({ error: "owner_only" }, 403);

    const { data: flag } = await admin.rpc("flag_evaluate", { p_key: "rre_certify", p_tenant: ownerId });
    if (flag !== true) return json({ error: "not_enabled" }, 404);

    const body = await req.json().catch(() => ({}));
    const action = String((body as { action?: unknown }).action ?? "status");

    const { data: s } = await admin.from("rr_certify_settings").select("*").eq("user_id", ownerId).maybeSingle();
    const settings: CertifySettings = s
      ? { alpha: Number(s.alpha), delta: Number(s.delta), windowDays: Number(s.window_days), minSegmentN: Number(s.min_segment_n), minPooledN: Number(s.min_pooled_n) }
      : DEFAULT_CERTIFY_SETTINGS;
    const { data: rrSettings } = await admin.from("remote_resolution_settings").select("attempt_threshold, truck_roll_cost_cents").eq("user_id", ownerId).maybeSingle();
    const fallbackThreshold = Number(rrSettings?.attempt_threshold ?? 55);
    const truckRollCostCents = Number(rrSettings?.truck_roll_cost_cents ?? 25000);

    const { data: raw, error } = await admin.rpc("rr_certify_case_outcomes", { p_user_id: ownerId });
    if (error) return json({ error: "outcomes_failed" }, 500);
    const rows: CaseOutcomeRow[] = ((raw ?? []) as Record<string, unknown>[]).map((r) => ({
      case_id: String(r.case_id), segment: segmentKey(String(r.category)), score: Number(r.score),
      threshold: r.threshold === null ? null : Number(r.threshold), thresholdSource: r.threshold_source === "logged" ? "logged" : "assumed_current",
      status: String(r.status), resolvedAt: (r.resolved_at as string) ?? null, reopenedAt: (r.reopened_at as string) ?? null, repeatJobAt: (r.repeat_job_at as string) ?? null,
    }));
    const now = new Date();

    if (action === "recalibrate") {
      const snap = buildSnapshot({ rows, settings, now, fallbackThreshold });
      const { data: id, error: e2 } = await admin.rpc("rr_certify_store_snapshot", { p_user_id: ownerId, p_snapshot: snap, p_fingerprint: snap.fingerprint });
      if (e2) return json({ error: "store_failed" }, 500);
      return json({ ok: true, snapshot: { ...snap, id }, guarantee: guaranteeView({ ...snap, id: String(id) }) });
    }

    const { data: latest } = await admin.from("rr_certify_snapshots").select("id, snapshot").eq("user_id", ownerId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const snapshot: CalibrationSnapshot | null = latest ? { ...(latest.snapshot as CalibrationSnapshot), id: latest.id as string } : null;

    // Shadow replay: first logged decision per case where the existing engine let the attempt go remote.
    const { data: dec } = await admin.from("rr_certify_decisions").select("case_id, would_decide, turn, created_at")
      .eq("user_id", ownerId).eq("existing_action", "troubleshoot").order("created_at", { ascending: false }).limit(5000);
    const firstByCase = new Map<string, boolean>();
    for (const d of (dec ?? []).sort((a, b) => Number(a.turn) - Number(b.turn))) if (!firstByCase.has(String(d.case_id))) firstByCase.set(String(d.case_id), d.would_decide === "allow_remote");
    const shadowRows: ShadowRow[] = [];
    const drift: DriftObservation[] = [];
    for (const r of rows) {
      if (!firstByCase.has(r.case_id)) continue;
      const lab = labelCase(r, settings.windowDays, now, fallbackThreshold);
      const closed = r.resolvedAt !== null && ["resolved_pending", "resolved_remotely", "reopened"].includes(r.status);
      const wouldAllow = firstByCase.get(r.case_id) === true;
      shadowRows.push({ caseId: r.case_id, wouldAllow, state: lab.state, closedResolved: closed, loss: lab.labeled?.loss ?? 0 });
      if (wouldAllow && lab.state !== "active") drift.push({ caseId: r.case_id, failureSeen: lab.labeled ? lab.labeled.loss === 1 : lab.earlyFailure === true });
    }
    const ref = snapshot ? driftReference(snapshot) : null;
    const driftState = evaluateDrift(drift, ref, DEFAULT_DRIFT_CONFIG);
    await admin.rpc("rr_certify_set_drift", { p_user_id: ownerId, p_status: driftState.status, p_m: driftState.m, p_k: driftState.k, p_reference: driftState.referenceRate, p_p_value: driftState.pValue });

    return json({
      ok: true, settings, snapshot, guarantee: guaranteeView(snapshot), drift: driftState,
      report: buildShadowReport(shadowRows, truckRollCostCents),
      assumptionsNote: "Statements hold only under the listed assumptions; see docs/rre-certification.md.",
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "rr_certify_unhandled", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "internal" }, 500);
  }
});
