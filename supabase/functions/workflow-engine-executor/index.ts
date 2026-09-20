// supabase/functions/workflow-engine-executor/index.ts
//
// Cron-driven executor for the Call-to-Cash Workflow Engine
// (see supabase/migrations/20261005000000_call_to_cash_workflow_engine.sql).
//
// Enrollment already happened in the database (match_workflow_definitions()
// trigger on business_activity_events). This function's only job is to run
// due steps:
//
//   1. Claim due steps atomically (pending -> running, WHERE status =
//      'pending'), so two overlapping cron ticks can never run the same
//      step twice.
//   2. Re-check DNC suppression before any sms/call step — a STOP could
//      have landed after enrollment, exactly like followup-agent-dispatcher.
//   3. Execute the step by type.
//   4. On success, call workflow_advance_run() to schedule the next step
//      (or complete the run). On failure, retry with backoff up to
//      max_attempts, then either stop the run or continue past it,
//      per the step's on_failure setting.
//
// DEPLOYMENT: supabase functions deploy workflow-engine-executor
// --no-verify-jwt, then point your existing cron (the one already
// hitting followup-agent-dispatcher) at this function too, every 1-2
// minutes, with the same X-Cron-Secret header.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isDncSuppressed } from "../_shared/compliance/dncCheck.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";

const BATCH_SIZE = 25;
const VAPI_CALL_URL = "https://api.vapi.ai/call";
const BACKOFF_CAP_MINUTES = 60;

type StepType = "sms" | "call" | "wait" | "webhook" | "human_approval" | "condition_gate";
type OnFailure = "continue" | "stop";

interface RunStep {
  id: string;
  run_id: string;
  step_number: number;
  step_type: StepType;
  config: Record<string, unknown>;
  on_failure: OnFailure;
  attempt_count: number;
  max_attempts: number;
}

interface Run {
  id: string;
  workflow_id: string;
  user_id: string;
  entity_type: string | null;
  entity_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  context: Record<string, unknown>;
  mode: "live" | "test";
}

function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === null || v === undefined ? "" : String(v);
  });
}

async function buildTemplateVars(admin: SupabaseClient, run: Run): Promise<Record<string, unknown>> {
  const vars: Record<string, unknown> = {
    customer_name: run.customer_name ?? "there",
    customer_phone: run.customer_phone ?? "",
    customer_email: run.customer_email ?? "",
    business_name: "our team",
    ...run.context,
  };
  const { data: profile } = await admin.from("profiles").select("company_name").eq("id", run.user_id).maybeSingle();
  if (profile?.company_name) vars.business_name = profile.company_name;
  return vars;
}

/** Re-checks the real-world condition a step names. Mirrors the stop-reason
 *  logic in followup-agent-dispatcher/index.ts's computeStopReason(). */
async function checkCondition(admin: SupabaseClient, run: Run, check: string): Promise<boolean> {
  switch (check) {
    case "quote_still_pending": {
      if (!run.entity_id) return false;
      const { data } = await admin.from("quotes").select("status").eq("id", run.entity_id).maybeSingle();
      return data?.status === "sent";
    }
    case "job_still_scheduled": {
      if (!run.entity_id) return false;
      const { data } = await admin.from("jobs").select("job_status").eq("id", run.entity_id).maybeSingle();
      return data?.job_status === "scheduled";
    }
    case "lead_not_progressed": {
      if (!run.entity_id) return false;
      const { data } = await admin.from("leads").select("stage").eq("id", run.entity_id).maybeSingle();
      return data?.stage === "new";
    }
    case "review_not_yet_left": {
      if (!run.entity_id) return false;
      const { data } = await admin
        .from("review_requests")
        .select("status")
        .eq("job_id", run.entity_id)
        .eq("status", "completed")
        .maybeSingle();
      return !data;
    }
    default:
      return true;
  }
}

async function runSmsStep(admin: SupabaseClient, run: Run, config: Record<string, unknown>) {
  if (!run.customer_phone) return { ok: false, terminal: true, error: "No customer phone on file." };
  const vars = await buildTemplateVars(admin, run);
  const body = renderTemplate(String(config.body ?? ""), vars);

  if (run.mode === "test") return { ok: true, result: { simulated: true, body } };

  const result = await sendCompliantSms(admin, run.user_id, run.customer_phone, body);
  if (result.ok) return { ok: true, result: { sid: result.sid, body } };
  const terminal = result.reason === "OPTED_OUT";
  return { ok: false, terminal, error: `${result.reason}${result.detail ? `: ${result.detail}` : ""}` };
}

async function runCallStep(admin: SupabaseClient, run: Run, config: Record<string, unknown>, vapiKey: string | undefined) {
  if (!run.customer_phone) return { ok: false, terminal: true, error: "No customer phone on file." };
  if (run.mode === "test") return { ok: true, result: { simulated: true } };
  if (!vapiKey) return { ok: false, terminal: true, error: "VAPI_PRIVATE_KEY not configured." };

  const { data: business } = await admin
    .from("business_profile")
    .select("vapi_assistant_id, vapi_phone_number_id")
    .eq("user_id", run.user_id)
    .maybeSingle();
  if (!business?.vapi_assistant_id || !business?.vapi_phone_number_id) {
    return { ok: false, terminal: true, error: "No Vapi assistant/phone number configured." };
  }

  try {
    const res = await fetch(VAPI_CALL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: business.vapi_assistant_id,
        phoneNumberId: business.vapi_phone_number_id,
        customer: { number: run.customer_phone },
        assistantOverrides: {
          variableValues: { customer_name: run.customer_name ?? "", followup_context: String(config.call_context ?? "") },
        },
      }),
    });
    if (!res.ok) return { ok: false, terminal: false, error: `Vapi error ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const json = await res.json();
    return { ok: true, result: { vapi_call_id: json.id ?? null } };
  } catch (err) {
    return { ok: false, terminal: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runWebhookStep(run: Run, config: Record<string, unknown>) {
  const url = String(config.url ?? "");
  if (!url) return { ok: false, terminal: true, error: "webhook step missing config.url" };
  if (run.mode === "test") return { ok: true, result: { simulated: true, url } };
  try {
    const res = await fetch(url, {
      method: String(config.method ?? "POST"),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: run.id, entity_type: run.entity_type, entity_id: run.entity_id,
        customer_name: run.customer_name, customer_phone: run.customer_phone,
        customer_email: run.customer_email, context: run.context,
      }),
    });
    if (!res.ok) return { ok: false, terminal: false, error: `Webhook returned ${res.status}` };
    return { ok: true, result: { status: res.status } };
  } catch (err) {
    return { ok: false, terminal: false, error: err instanceof Error ? err.message : String(err) };
  }
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY");
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: dueSteps, error } = await admin
    .from("workflow_run_steps")
    .select("id, run_id, step_number, step_type, config, on_failure, attempt_count, max_attempts")
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!dueSteps || dueSteps.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  let succeeded = 0, failed = 0, skipped = 0, awaitingApproval = 0;

  for (const step of dueSteps as RunStep[]) {
    // 1. Claim atomically. If another tick already grabbed it, move on.
    const { data: claimed } = await admin
      .from("workflow_run_steps")
      .update({ status: "running", started_at: new Date().toISOString(), attempt_count: step.attempt_count + 1 })
      .eq("id", step.id)
      .eq("status", "pending")
      .select("attempt_count")
      .maybeSingle();
    if (!claimed) continue;
    const attempt = claimed.attempt_count as number;

    const { data: run } = await admin
      .from("workflow_runs")
      .select("id, workflow_id, user_id, entity_type, entity_id, customer_name, customer_phone, customer_email, context, mode, status")
      .eq("id", step.run_id)
      .maybeSingle();

    if (!run || run.status !== "active") {
      await admin.from("workflow_run_steps").update({ status: "skipped", completed_at: new Date().toISOString() }).eq("id", step.id);
      skipped += 1;
      continue;
    }
    const typedRun = run as unknown as Run;

    // 2. DNC re-check for anything that talks to the customer.
    if ((step.step_type === "sms" || step.step_type === "call") && typedRun.customer_phone) {
      if (await isDncSuppressed(admin, typedRun.user_id, typedRun.customer_phone)) {
        await admin.from("workflow_run_steps").update({ status: "skipped", completed_at: new Date().toISOString(), error: "customer_opted_out" }).eq("id", step.id);
        await admin.from("workflow_runs").update({ status: "cancelled", stop_reason: "customer_opted_out", completed_at: new Date().toISOString() }).eq("id", typedRun.id);
        skipped += 1;
        continue;
      }
    }

    // 3. Human approval: create the request (once) and pause the run.
    if (step.step_type === "human_approval") {
      await admin.from("workflow_approvals").upsert(
        { run_id: typedRun.id, run_step_id: step.id, user_id: typedRun.user_id, reason: String(step.config.reason ?? "Approval required") },
        { onConflict: "run_step_id", ignoreDuplicates: true },
      );
      await admin.from("workflow_run_steps").update({ status: "awaiting_approval" }).eq("id", step.id);
      await admin.from("workflow_runs").update({ status: "waiting_approval" }).eq("id", typedRun.id);
      awaitingApproval += 1;
      continue;
    }

    // 4. Condition gate: re-check reality before continuing.
    if (step.step_type === "condition_gate") {
      const passed = await checkCondition(admin, typedRun, String(step.config.check ?? ""));
      if (!passed) {
        await admin.from("workflow_run_steps").update({ status: "skipped", completed_at: new Date().toISOString(), result: { condition_failed: step.config.check } }).eq("id", step.id);
        await admin.from("workflow_runs").update({ status: "cancelled", stop_reason: `condition_failed:${step.config.check}`, completed_at: new Date().toISOString() }).eq("id", typedRun.id);
        skipped += 1;
      } else {
        await admin.from("workflow_run_steps").update({ status: "succeeded", completed_at: new Date().toISOString() }).eq("id", step.id);
        await admin.rpc("workflow_advance_run", { p_run_id: typedRun.id, p_completed_step_number: step.step_number, p_status: "active" });
        succeeded += 1;
      }
      continue;
    }

    // 5. Wait: pure timer, the delay already happened via scheduled_at.
    if (step.step_type === "wait") {
      await admin.from("workflow_run_steps").update({ status: "succeeded", completed_at: new Date().toISOString() }).eq("id", step.id);
      await admin.rpc("workflow_advance_run", { p_run_id: typedRun.id, p_completed_step_number: step.step_number, p_status: "active" });
      succeeded += 1;
      continue;
    }

    // 6. sms / call / webhook — the side-effecting steps.
    let outcome: { ok: boolean; terminal?: boolean; result?: unknown; error?: string };
    if (step.step_type === "sms") outcome = await runSmsStep(admin, typedRun, step.config);
    else if (step.step_type === "call") outcome = await runCallStep(admin, typedRun, step.config, vapiKey);
    else outcome = await runWebhookStep(typedRun, step.config);

    if (outcome.ok) {
      await admin.from("workflow_run_steps").update({ status: "succeeded", completed_at: new Date().toISOString(), result: outcome.result ?? {} }).eq("id", step.id);
      await admin.rpc("workflow_advance_run", { p_run_id: typedRun.id, p_completed_step_number: step.step_number, p_status: "active" });
      succeeded += 1;

      // Mirror this automated touch onto the Revenue Recovery Ledger, if
      // this entity has an open/contacted entry there — same follow-up
      // count a human clicking "log follow-up" on that page would create.
      // See 20261006000000_workflow_revenue_attribution.sql.
      const sourceTable = typedRun.entity_type === "call" ? "calls" : typedRun.entity_type === "quote" ? "quotes" : null;
      if (sourceTable && typedRun.entity_id && (step.step_type === "sms" || step.step_type === "call")) {
        await admin.rpc("log_workflow_engine_followup", {
          p_source_table: sourceTable,
          p_source_id: typedRun.entity_id,
          p_method: step.step_type === "sms" ? "sms" : "callback",
          p_run_id: typedRun.id,
        });
      }
      continue;
    }

    // Failure: retry with backoff unless terminal or attempts exhausted.
    const exhausted = outcome.terminal || attempt >= step.max_attempts;
    if (!exhausted) {
      const backoffMinutes = Math.min(2 ** attempt, BACKOFF_CAP_MINUTES);
      await admin.from("workflow_run_steps").update({
        status: "pending",
        scheduled_at: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
        error: outcome.error ?? null,
      }).eq("id", step.id);
      failed += 1;
      continue;
    }

    await admin.from("workflow_run_steps").update({ status: "failed", completed_at: new Date().toISOString(), error: outcome.error ?? "unknown error" }).eq("id", step.id);
    if (step.on_failure === "stop") {
      await admin.from("workflow_runs").update({ status: "failed", stop_reason: `step_${step.step_number}_failed`, completed_at: new Date().toISOString() }).eq("id", typedRun.id);
    } else {
      await admin.rpc("workflow_advance_run", { p_run_id: typedRun.id, p_completed_step_number: step.step_number, p_status: "active" });
    }
    failed += 1;

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return new Response(
    JSON.stringify({ processed: dueSteps.length, succeeded, failed, skipped, awaitingApproval }),
    { headers: { "Content-Type": "application/json" } },
  );
});
