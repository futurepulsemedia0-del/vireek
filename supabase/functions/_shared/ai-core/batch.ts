// supabase/functions/_shared/ai-core/batch.ts
//
// Batch mode for NON-REALTIME jobs, via Anthropic's Message Batches API (asynchronous, discounted, results
// within 24h). Pure request builders + result parsers; the network and DB live in the ai-batch-runner
// edge function so this file stays unit-testable. Behind AI_BATCH_MODE=1.
//
// Eligibility is a CALLER decision: only work nobody is waiting on may be queued (see BATCH_ELIGIBLE_TASKS).
// Live calls, emergencies, dispatch and anything customer-facing must keep using askVireekAi directly.
//
// Wire format [VERIFY against docs.anthropic.com "Message Batches"]:
//   POST /v1/messages/batches        { requests: [{ custom_id, params: <Messages request> }] }
//   GET  /v1/messages/batches/{id}   { processing_status: "in_progress"|"canceling"|"ended", results_url }
//   GET  results_url                 JSONL, one { custom_id, result: { type, message? } } per request

import type { TaskType } from "./types.ts";

/** Tasks that are periodic / post-hoc reporting. Anything not listed here is rejected by enqueue. */
export const BATCH_ELIGIBLE_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  "business_insights",
  "business_drift_narrative",
  "cash_flow_narrative",
  "executive_report_commentary",
  "regional_demand_narrative",
  "capacity_demand_narrative",
  "staffing_forecast_narrative",
  "outcome_benchmark_advice",
  "workforce_equilibrium_narrative",
  "job_autopsy",
  "callback_root_cause",
  "business_scientist_hypothesis",
  "field_scientist_causes",
  "continual_identity_learner",
  "bank_categorization",
  "bank_transaction_categorization",
]);

export const MAX_BATCH_REQUESTS = 1000; // well under the provider limit; keeps one runner pass bounded
export const MAX_REQUEST_CHARS = 200_000;

export interface BatchJobRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
}

export type BatchValidation = { ok: true } | { ok: false; reason: string };

export function validateBatchRequest(task: TaskType, r: BatchJobRequest): BatchValidation {
  if (!BATCH_ELIGIBLE_TASKS.has(task)) return { ok: false, reason: "task_not_batch_eligible" };
  if (!r.messages.length) return { ok: false, reason: "no_messages" };
  if (!Number.isInteger(r.maxTokens) || r.maxTokens < 1 || r.maxTokens > 16_000) return { ok: false, reason: "bad_max_tokens" };
  const size = r.system.length + r.messages.reduce((n, m) => n + m.content.length, 0);
  if (size > MAX_REQUEST_CHARS) return { ok: false, reason: "request_too_large" };
  return { ok: true };
}

/** custom_id must match ^[a-zA-Z0-9_-]{1,64}$. A job uuid without dashes is 32 chars + prefix. */
export function customIdForJob(jobId: string): string {
  return `j${jobId.replace(/-/g, "")}`;
}

export function jobIdFromCustomId(customId: string): string | null {
  const m = /^j([0-9a-f]{32})$/.exec(customId);
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const JSON_ONLY_RULE =
  "Respond with ONLY a single valid JSON object. No prose, no markdown code fences, no explanation before or after it.";

export interface BatchRow {
  id: string;
  request: BatchJobRequest;
}

export function buildAnthropicBatchBody(rows: readonly BatchRow[], model: string) {
  if (!rows.length || rows.length > MAX_BATCH_REQUESTS) throw new Error("batch size out of range");
  return {
    requests: rows.map((row) => ({
      custom_id: customIdForJob(row.id),
      params: {
        model,
        max_tokens: row.request.maxTokens,
        temperature: row.request.temperature ?? 0,
        system: row.request.jsonMode ? `${row.request.system}\n\n${JSON_ONLY_RULE}` : row.request.system,
        messages: row.request.messages,
      },
    })),
  };
}

export type BatchOutcome =
  | { jobId: string; ok: true; text: string; model: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } }
  | { jobId: string; ok: false; errorCode: "errored" | "canceled" | "expired" | "empty" | "unknown" };

/** Parses the JSONL results body. Malformed lines are skipped (their job stays unresolved and is retried). */
export function parseAnthropicBatchResults(jsonl: string): BatchOutcome[] {
  const out: BatchOutcome[] = [];
  for (const line of jsonl.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let row: { custom_id?: unknown; result?: { type?: string; message?: { content?: { type: string; text?: string }[]; model?: string; usage?: Record<string, unknown> } } };
    try {
      row = JSON.parse(s);
    } catch {
      continue;
    }
    const jobId = typeof row.custom_id === "string" ? jobIdFromCustomId(row.custom_id) : null;
    if (!jobId) continue;
    const type = row.result?.type;
    if (type === "succeeded") {
      const msg = row.result?.message;
      const text = (msg?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
      if (!text) {
        out.push({ jobId, ok: false, errorCode: "empty" });
        continue;
      }
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
      const u = msg?.usage ?? {};
      out.push({
        jobId,
        ok: true,
        text,
        model: msg?.model ?? "",
        usage: {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cacheReadTokens: num(u.cache_read_input_tokens),
          cacheWriteTokens: num(u.cache_creation_input_tokens),
        },
      });
    } else if (type === "errored" || type === "canceled" || type === "expired") {
      out.push({ jobId, ok: false, errorCode: type });
    } else {
      out.push({ jobId, ok: false, errorCode: "unknown" });
    }
  }
  return out;
}

export const BATCH_MAX_ATTEMPTS = 3;

/** Whether a failed job should go back to the queue (transient) or be marked failed (final). */
export function shouldRetry(errorCode: string, attempts: number): boolean {
  if (attempts >= BATCH_MAX_ATTEMPTS) return false;
  return errorCode === "errored" || errorCode === "expired" || errorCode === "unknown";
}
