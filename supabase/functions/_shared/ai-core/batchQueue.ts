// supabase/functions/_shared/ai-core/batchQueue.ts
//
// Enqueue side of batch mode. A non-realtime job calls enqueueBatchJob() instead of askVireekAi(); the
// ai-batch-runner cron function submits it to the provider's batch API and stores the result on the row.
// Tenant scoping: every row carries account_id and the (account_id, idempotency_key) pair is unique, so a
// retried producer gets the SAME job back instead of paying twice.

import type { TaskType } from "./types.ts";
import { validateBatchRequest, type BatchJobRequest } from "./batch.ts";

export type BatchJobStatus = "pending" | "submitting" | "submitted" | "succeeded" | "failed" | "canceled";

export interface BatchJobView {
  id: string;
  status: BatchJobStatus;
  resultText: string | null;
  errorCode: string | null;
}

interface Result<T> {
  data: T | null;
  error: { message: string } | null;
}

/** The slice of supabase-js used here (injectable for tests). */
export interface BatchDbClient {
  from(table: string): {
    upsert(row: Record<string, unknown>, opts: { onConflict: string; ignoreDuplicates: boolean }): PromiseLike<{ error: { message: string } | null }>;
    select(cols: string): {
      eq(col: string, v: string): {
        eq(col: string, v: string): { maybeSingle(): PromiseLike<Result<Record<string, unknown>>> };
      };
    };
  };
}

export type EnqueueResult =
  | { ok: true; job: BatchJobView }
  | { ok: false; reason: string };

function view(r: Record<string, unknown>): BatchJobView {
  return {
    id: String(r.id),
    status: r.status as BatchJobStatus,
    resultText: typeof r.result_text === "string" ? r.result_text : null,
    errorCode: typeof r.error_code === "string" ? r.error_code : null,
  };
}

const COLS = "id,status,result_text,error_code";

export async function enqueueBatchJob(
  db: BatchDbClient,
  input: { accountId: string; task: TaskType; source?: string; idempotencyKey: string; request: BatchJobRequest; enabled: boolean },
): Promise<EnqueueResult> {
  if (!input.enabled) return { ok: false, reason: "batch_mode_off" };
  if (!input.accountId) return { ok: false, reason: "no_account_scope" };
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) return { ok: false, reason: "bad_idempotency_key" };
  const v = validateBatchRequest(input.task, input.request);
  if (!v.ok) return { ok: false, reason: v.reason };

  // ignoreDuplicates => ON CONFLICT DO NOTHING: a second enqueue of the same key never overwrites a running job.
  const ins = await db.from("ai_batch_jobs").upsert(
    {
      account_id: input.accountId,
      task: input.task,
      source: input.source ?? null,
      idempotency_key: input.idempotencyKey,
      request: input.request,
    },
    { onConflict: "account_id,idempotency_key", ignoreDuplicates: true },
  );
  if (ins.error) return { ok: false, reason: "db_error" };
  const row = await getBatchJobByKey(db, input.accountId, input.idempotencyKey);
  return row ? { ok: true, job: row } : { ok: false, reason: "db_error" };
}

export async function getBatchJobByKey(db: BatchDbClient, accountId: string, idempotencyKey: string): Promise<BatchJobView | null> {
  const { data, error } = await db.from("ai_batch_jobs").select(COLS).eq("account_id", accountId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (error || !data) return null;
  return view(data);
}
