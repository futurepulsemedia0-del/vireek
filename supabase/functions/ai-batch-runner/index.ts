// supabase/functions/ai-batch-runner/index.ts
//
// Cron entry point (suggested: every 10 minutes) for AI batch mode (AI_BATCH_MODE=1).
//   1. COLLECT: for batches the provider reports as ended, fetch the JSONL results and finish each job.
//   2. SUBMIT:  claim pending jobs (FOR UPDATE SKIP LOCKED) and send them as ONE provider batch.
// Auth: fail-closed CRON_SECRET (x-cron-secret). Service-role DB access only. Never logs prompts or results.
// Secrets: CRON_SECRET, ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY. Flag: AI_BATCH_MODE=1.
// Deploy: supabase functions deploy ai-batch-runner --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireCronAuth } from "../_shared/http/cronAuth.ts";
import { readCostFlags } from "../_shared/ai-core/llmCost.ts";
import { getModel } from "../_shared/ai-core/providers/anthropic.ts";
import { shouldRetry, MAX_BATCH_REQUESTS, type BatchJobRequest, type BatchOutcome } from "../_shared/ai-core/batch.ts";
import { createAnthropicBatchClient, getAnthropicBatchKey } from "../_shared/ai-core/batchClient.ts";
import { estimateCostDetailed, logUsage } from "../_shared/ai-core/costTracking.ts";
import type { TaskType } from "../_shared/ai-core/types.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

interface JobRow { id: string; account_id: string; task: TaskType; source: string | null; request: BatchJobRequest; attempts: number; provider_batch_id: string | null; created_at: string }

Deno.serve(async (req: Request) => {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  if (!readCostFlags((n) => Deno.env.get(n)).batch) return json({ skipped: "AI_BATCH_MODE is off" });
  const apiKey = getAnthropicBatchKey();
  if (!apiKey) return json({ error: "Service not configured." }, 503);

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const client = createAnthropicBatchClient(apiKey);
  const summary = { collectedBatches: 0, succeeded: 0, failed: 0, requeued: 0, submittedJobs: 0, errors: [] as string[] };

  // ---------- 1. COLLECT ----------
  const { data: inflight } = await db.from("ai_batch_jobs").select("provider_batch_id").eq("status", "submitted").not("provider_batch_id", "is", null).limit(500);
  const batchIds = [...new Set((inflight ?? []).map((r: { provider_batch_id: string }) => r.provider_batch_id))].slice(0, 20);
  for (const batchId of batchIds) {
    try {
      const outcomes = await client.collect(batchId);
      if (!outcomes) continue; // still processing
      const { data: rows } = await db.from("ai_batch_jobs").select("id,account_id,task,source,request,attempts,provider_batch_id,created_at").eq("provider_batch_id", batchId).eq("status", "submitted");
      const byId = new Map<string, BatchOutcome>(outcomes.map((o) => [o.jobId, o]));
      for (const row of (rows ?? []) as JobRow[]) {
        await finishJob(db, row, byId.get(row.id) ?? { jobId: row.id, ok: false, errorCode: "unknown" }, summary);
      }
      summary.collectedBatches++;
    } catch (err) {
      summary.errors.push(`collect ${batchId}: ${err instanceof Error ? err.name : "error"}`);
    }
  }

  // ---------- 2. SUBMIT ----------
  const { data: claimed, error: claimErr } = await db.rpc("ai_batch_claim_pending", { p_limit: MAX_BATCH_REQUESTS });
  if (claimErr) { summary.errors.push("claim failed"); return json(summary, 500); }
  const jobs = (claimed ?? []) as JobRow[];
  if (jobs.length) {
    const ids = jobs.map((j) => j.id);
    try {
      const { batchId } = await client.submit(jobs.map((j) => ({ id: j.id, request: j.request })), getModel());
      await db.from("ai_batch_jobs").update({ status: "submitted", provider_batch_id: batchId, submitted_at: new Date().toISOString() }).in("id", ids);
      summary.submittedJobs = ids.length;
    } catch (err) {
      // Return the jobs to the queue (attempts was already incremented by the claim); jobs out of attempts fail for good.
      summary.errors.push(`submit: ${err instanceof Error ? err.message : "error"}`);
      const retry = jobs.filter((j) => j.attempts < 3).map((j) => j.id);
      const dead = jobs.filter((j) => j.attempts >= 3).map((j) => j.id);
      if (retry.length) await db.from("ai_batch_jobs").update({ status: "pending" }).in("id", retry);
      if (dead.length) await db.from("ai_batch_jobs").update({ status: "failed", error_code: "submit_failed", completed_at: new Date().toISOString() }).in("id", dead);
    }
  }
  return json(summary);
});

async function finishJob(db: ReturnType<typeof createClient>, row: JobRow, o: BatchOutcome, summary: { succeeded: number; failed: number; requeued: number }) {
  const now = new Date().toISOString();
  if (o.ok) {
    const model = o.model || getModel();
    const detail = estimateCostDetailed("anthropic", model, { ...o.usage }, true);
    // The status guard makes completion exactly-once: a concurrent runner that lost the race updates 0 rows
    // and must not write a second usage-log / ledger entry.
    const { data: won } = await db.from("ai_batch_jobs").update({
      status: "succeeded", result_text: o.text, model, input_tokens: o.usage.inputTokens, output_tokens: o.usage.outputTokens,
      cache_read_tokens: o.usage.cacheReadTokens, cache_write_tokens: o.usage.cacheWriteTokens,
      cost_usd: detail.costUsd, saved_usd: detail.savedUsd, completed_at: now, error_code: null,
    }).eq("id", row.id).eq("status", "submitted").select("id");
    if (!won || won.length === 0) return;
    await logUsage({
      accountId: row.account_id, task: row.task, source: row.source ?? "ai-batch-runner",
      response: { text: o.text, provider: "anthropic", model, latencyMs: Math.max(0, Date.now() - Date.parse(row.created_at)), wasFallback: false },
      usage: { ...o.usage, estimated: false }, attempts: [], batched: true,
    });
    summary.succeeded++;
    return;
  }
  if (shouldRetry(o.errorCode, row.attempts)) {
    await db.from("ai_batch_jobs").update({ status: "pending", provider_batch_id: null, error_code: o.errorCode }).eq("id", row.id).eq("status", "submitted");
    summary.requeued++;
  } else {
    await db.from("ai_batch_jobs").update({ status: "failed", error_code: o.errorCode, completed_at: now }).eq("id", row.id).eq("status", "submitted");
    summary.failed++;
  }
}
