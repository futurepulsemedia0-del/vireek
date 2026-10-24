// supabase/functions/synthetic-probe/index.ts
//
// Synthetic test calls through the REAL AI path. Two actions, both driven by cron every minute:
//   { action: "dispatch" } claim due targets and place a probe call (Vapi caller assistant -> target number)
//   { action: "verify"   } poll finished probe calls, read what the product stored, record SLI events
//
// Secrets: VAPI_PRIVATE_KEY, PUSH_DISPATCH_SECRET (already used by dispatch-webhook).
// Deploy:  supabase functions deploy synthetic-probe --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isAuthorizedCaller, json } from "../_shared/synthetic/auth.ts";
import {
  buildProbeScript,
  evaluateRun,
  getScenario,
  isCallHung,
  isVerificationFinal,
  type ProbeCallReport,
} from "../_shared/synthetic/metrics.ts";

const VAPI_CALL_URL = "https://api.vapi.ai/call";
const MAX_VERIFY_ATTEMPTS = 15;
const FETCH_TIMEOUT_MS = 15_000;

type Admin = ReturnType<typeof createClient>;

interface Target {
  id: string;
  region: string;
  target_number: string;
  tenant_user_id: string;
  probe_caller_number: string;
  probe_phone_number_id: string;
  probe_assistant_id: string;
  scenario_key: string;
}

interface RunRow {
  id: string;
  target_id: string;
  region: string;
  scenario_key: string;
  status: string;
  started_at: string;
  vapi_call_id: string | null;
  verify_attempts: number;
}

async function vapiFetch(url: string, key: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function dispatch(admin: Admin, vapiKey: string) {
  const { data: targets, error } = await admin.rpc("synthetic_claim_due_targets", { p_limit: 10 });
  if (error) return json({ error: error.message }, 500);
  let dialed = 0;
  let failed = 0;

  for (const t of (targets ?? []) as Target[]) {
    const { data: run, error: runErr } = await admin
      .from("synthetic_probe_runs")
      .insert({ target_id: t.id, region: t.region, scenario_key: t.scenario_key, status: "dialing" })
      .select("id")
      .single();
    if (runErr || !run) {
      failed += 1;
      continue;
    }
    try {
      const res = await vapiFetch(VAPI_CALL_URL, vapiKey, {
        method: "POST",
        body: JSON.stringify({
          assistantId: t.probe_assistant_id,
          phoneNumberId: t.probe_phone_number_id,
          customer: { number: t.target_number },
          assistantOverrides: {
            variableValues: { probe_script: buildProbeScript(getScenario(t.scenario_key)), probe_run_id: run.id },
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        await admin.from("synthetic_probe_runs").update({
          status: "error", failure_stage: "dial", finished_at: new Date().toISOString(),
          error: `Vapi create-call failed (${res.status}): ${body}`,
        }).eq("id", run.id);
        failed += 1;
        continue;
      }
      const created = (await res.json()) as { id?: string };
      await admin.from("synthetic_probe_runs").update({ vapi_call_id: created.id ?? null }).eq("id", run.id);
      dialed += 1;
    } catch (err) {
      await admin.from("synthetic_probe_runs").update({
        status: "error", failure_stage: "dial", finished_at: new Date().toISOString(),
        error: `Vapi create-call exception: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      }).eq("id", run.id);
      failed += 1;
    }
  }
  return json({ dialed, failed });
}

async function finishRun(admin: Admin, run: RunRow, patch: Record<string, unknown>) {
  await admin.from("synthetic_probe_runs").update({ ...patch, finished_at: new Date().toISOString() }).eq("id", run.id);
}

async function verifyOne(admin: Admin, vapiKey: string, run: RunRow, now: number): Promise<"done" | "waiting"> {
  if (!run.vapi_call_id) {
    if (now - Date.parse(run.started_at) > 2 * 60_000) {
      await finishRun(admin, run, { status: "error", failure_stage: "dial", error: "Probe call was never created" });
      return "done";
    }
    return "waiting";
  }

  let call: ProbeCallReport | null = null;
  try {
    const res = await vapiFetch(`${VAPI_CALL_URL}/${run.vapi_call_id}`, vapiKey);
    if (res.ok) call = (await res.json()) as ProbeCallReport;
  } catch {
    call = null;
  }
  if (!call) {
    if (run.verify_attempts + 1 >= MAX_VERIFY_ATTEMPTS) {
      await finishRun(admin, run, { status: "error", failure_stage: "probe", error: "Could not read the probe call from Vapi" });
      return "done";
    }
    await admin.from("synthetic_probe_runs").update({ verify_attempts: run.verify_attempts + 1 }).eq("id", run.id);
    return "waiting";
  }

  if (call.status !== "ended") {
    if (isCallHung(run.started_at, now)) {
      await finishRun(admin, run, { status: "error", failure_stage: "probe", error: "Probe call never ended (hung)" });
      return "done";
    }
    return "waiting";
  }

  const { data: target } = await admin
    .from("synthetic_probe_targets")
    .select("tenant_user_id, probe_caller_number")
    .eq("id", run.target_id)
    .maybeSingle();
  if (!target) {
    await finishRun(admin, run, { status: "error", failure_stage: "probe", error: "Target no longer exists" });
    return "done";
  }

  const since = new Date(Date.parse(run.started_at) - 30_000).toISOString();
  const { data: callRow } = await admin
    .from("calls")
    .select("id, transcript, created_at")
    .eq("user_id", target.tenant_user_id)
    .eq("caller_phone", target.probe_caller_number)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: jobRow } = callRow
    ? await admin.from("jobs").select("id, created_at").eq("call_id", callRow.id).limit(1).maybeSingle()
    : { data: null };

  const { data: receipts } = await admin
    .from("synthetic_webhook_receipts")
    .select("event, record_id, received_at")
    .eq("target_id", run.target_id)
    .gte("received_at", since);

  const evaluation = evaluateRun({
    scenarioKey: run.scenario_key,
    call,
    targetCall: callRow ? { id: callRow.id, transcript: callRow.transcript } : null,
    job: jobRow ? { id: jobRow.id, created_at: jobRow.created_at } : null,
    receipts: (receipts ?? []) as { event: string; record_id: string | null; received_at: string }[],
    targetCallCreatedAt: callRow?.created_at ?? null,
    now,
    final: isVerificationFinal(call, now),
  });

  if (!evaluation.complete) {
    await admin.from("synthetic_probe_runs").update({
      status: "verifying", verify_attempts: run.verify_attempts + 1, details: evaluation.details,
    }).eq("id", run.id);
    return "waiting";
  }

  await finishRun(admin, run, {
    status: evaluation.status,
    failure_stage: evaluation.failureStage,
    error: evaluation.error,
    answered: evaluation.answered,
    answer_latency_ms: evaluation.answerLatencyMs,
    asr_accuracy: evaluation.asrAccuracy,
    booking_ok: evaluation.bookingOk,
    webhook_ok: evaluation.webhookOk,
    webhook_latency_ms: evaluation.webhookLatencyMs,
    target_call_id: callRow?.id ?? null,
    job_id: jobRow?.id ?? null,
    details: evaluation.details,
  });

  if (evaluation.slis.length > 0) {
    await admin.from("synthetic_sli_events").upsert(
      evaluation.slis.map((s) => ({
        run_id: run.id, target_id: run.target_id, region: run.region, sli: s.sli, good: s.good, value: s.value,
      })),
      { onConflict: "run_id,sli", ignoreDuplicates: true },
    );
  }

  // Free the probe tenant's schedule slot so the next run can book again (probe tenants only).
  if (jobRow) {
    const { data: prof } = await admin.from("profiles").select("is_synthetic_tenant").eq("id", target.tenant_user_id).maybeSingle();
    if (prof?.is_synthetic_tenant) await admin.from("jobs").delete().eq("id", jobRow.id).eq("user_id", target.tenant_user_id);
  }
  return "done";
}

async function verify(admin: Admin, vapiKey: string) {
  const { data: runs, error } = await admin
    .from("synthetic_probe_runs")
    .select("id, target_id, region, scenario_key, status, started_at, vapi_call_id, verify_attempts")
    .in("status", ["dialing", "verifying"])
    .order("started_at", { ascending: true })
    .limit(25);
  if (error) return json({ error: error.message }, 500);
  const now = Date.now();
  let done = 0;
  let waiting = 0;
  for (const run of (runs ?? []) as RunRow[]) {
    try {
      (await verifyOne(admin, vapiKey, run, now)) === "done" ? (done += 1) : (waiting += 1);
    } catch (err) {
      console.error("synthetic_verify_failed", run.id, err instanceof Error ? err.message : String(err));
      waiting += 1;
    }
  }
  return json({ done, waiting });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorizedCaller(req)) return json({ error: "Unauthorized" }, 401);

  const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!vapiKey || !url || !key) return json({ error: "Server not configured" }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let action = "";
  try {
    action = ((await req.json()) as { action?: string }).action ?? "";
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (action === "dispatch") return await dispatch(admin, vapiKey);
  if (action === "verify") return await verify(admin, vapiKey);
  return json({ error: "action must be dispatch or verify" }, 400);
});
