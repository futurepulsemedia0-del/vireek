// supabase/functions/_shared/economics/ledgerWriter.ts
//
// Appends metered cost events to public.cost_ledger (append-only). NEVER throws: a failed ledger write must not
// break call handling or an AI response. Money is integer micro-USD (see microDollars.ts).

import { usdToMicro } from "./microDollars.ts";

export type ResourceType =
  | "llm_tokens" | "voice_minutes" | "stt" | "tts" | "sms_segments" | "telephony" | "maps" | "storage" | "other_api";

export interface CostEventInput {
  accountId: string | null;
  provider: string;
  resourceType: ResourceType;
  component?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPriceUsd?: string | null;
  rateId?: string | null;
  priceEffectiveFrom?: string | null;
  costMicro: number;
  basis: "estimated" | "provider_reported" | "invoiced";
  callId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  agentActionLogId?: string | null;
  /** marketplace_agent_runs.id, so third-party agent runs can be costed against marketplace_agent_ledger revenue. */
  marketplaceRunId?: string | null;
  taskType?: string | null;
  source: string;
  /** Idempotency key within `source`. Provide one whenever the producer can be retried (webhooks). */
  ref?: string | null;
  occurredAt?: string;
}

/** Correlation ids a producer can attach to a cost event. */
export interface LedgerCorrelation {
  callId?: string | null;
  jobId?: string | null;
  workflowRunId?: string | null;
  agentActionLogId?: string | null;
  marketplaceRunId?: string | null;
}

export function componentToResource(component: string): ResourceType {
  if (component === "asr") return "stt";
  if (component === "tts") return "tts";
  if (component === "llm") return "llm_tokens";
  if (component === "voice_platform") return "voice_minutes";
  if (component.startsWith("carrier_")) return "telephony";
  if (component === "sms_segment") return "sms_segments";
  if (component === "recording_storage") return "storage";
  return "other_api";
}

export function hasCorrelation(e: Pick<CostEventInput, "callId" | "jobId" | "workflowRunId" | "agentActionLogId" | "marketplaceRunId">): boolean {
  return Boolean(e.callId || e.jobId || e.workflowRunId || e.agentActionLogId || e.marketplaceRunId);
}

/** Pure + validating: throws RangeError on programmer errors so tests catch them; appendCostEvent swallows them. */
export function buildLedgerRow(e: CostEventInput): Record<string, unknown> {
  if (!Number.isSafeInteger(e.costMicro) || e.costMicro < 0) throw new RangeError("costMicro must be a non-negative safe integer");
  if (!e.provider.trim() || !e.source.trim()) throw new RangeError("provider and source are required");
  return {
    account_id: e.accountId, provider: e.provider.trim().toLowerCase(), resource_type: e.resourceType,
    component: e.component ?? null, quantity: e.quantity ?? null, unit: e.unit ?? null,
    unit_price_usd: e.unitPriceUsd ?? null, rate_id: e.rateId ?? null, price_effective_from: e.priceEffectiveFrom ?? null,
    cost_micro: e.costMicro, basis: e.basis, kind: "usage",
    call_id: e.callId ?? null, job_id: e.jobId ?? null, workflow_run_id: e.workflowRunId ?? null,
    agent_action_log_id: e.agentActionLogId ?? null, marketplace_run_id: e.marketplaceRunId ?? null, task_type: e.taskType ?? null,
    source: e.source, ref: e.ref ?? null, ...(e.occurredAt ? { occurred_at: e.occurredAt } : {}),
  };
}

/** Convenience for sources that only have a float USD figure (provider-reported or list-price estimate). */
export function usdEvent(e: Omit<CostEventInput, "costMicro"> & { costUsd: number }): CostEventInput {
  const { costUsd, ...rest } = e;
  return { ...rest, costMicro: usdToMicro(Math.max(0, costUsd)) };
}

interface LedgerClient {
  from(table: string): {
    upsert(rows: unknown, opts: { onConflict: string; ignoreDuplicates: boolean }): PromiseLike<{ error: { message: string } | null }>;
  };
}

export async function appendCostEvent(admin: LedgerClient, e: CostEventInput): Promise<void> {
  try {
    const { error } = await admin.from("cost_ledger").upsert(buildLedgerRow(e), { onConflict: "source,ref", ignoreDuplicates: true });
    if (error) console.error("[cost-ledger] not recorded:", error.message);
  } catch (err) {
    console.error("[cost-ledger] not recorded:", err);
  }
}
