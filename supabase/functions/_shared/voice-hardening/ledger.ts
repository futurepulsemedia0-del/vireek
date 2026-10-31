// Idempotency + dead-letter for Vapi end-of-call-report deliveries (table: voice_webhook_events).
// Pure state machine over a small store port; the Supabase adapter is at the bottom.
// Fails OPEN: if the ledger itself is unavailable (e.g. migration not applied) the event is processed as before.

export type LedgerStatus = "processing" | "processed" | "failed" | "dead" | "replayed";
export interface LedgerRow { id: string; status: LedgerStatus; attempts: number; updated_at: string }
export interface LedgerKey { userId: string; vapiCallId: string; eventType: string }

export interface LedgerStore {
  /** Insert a new 'processing' row. created=false means the unique key already existed and `row` is the existing one. */
  claim(key: LedgerKey): Promise<{ row: LedgerRow; created: boolean }>;
  /** Optimistic takeover of a failed/stale row. Returns null if someone else changed it first. */
  reclaim(row: LedgerRow): Promise<LedgerRow | null>;
  mark(id: string, patch: { status: LedgerStatus; last_error?: string | null; payload?: Record<string, unknown> }): Promise<void>;
}

export const MAX_ATTEMPTS = 5;
export const STALE_PROCESSING_MS = 120_000;

export type ClaimDecision = "process" | "duplicate" | "retry" | "dead";

export function decideClaim(row: LedgerRow, created: boolean, nowMs: number): ClaimDecision {
  if (created) return "process";
  if (row.status === "processed" || row.status === "replayed") return "duplicate";
  if (row.status === "dead") return "dead";
  if (row.status === "processing") {
    const age = nowMs - Date.parse(row.updated_at);
    if (Number.isFinite(age) && age < STALE_PROCESSING_MS) return "duplicate"; // another delivery is in flight
  }
  return row.attempts >= MAX_ATTEMPTS ? "dead" : "retry";
}

export type ClaimResult =
  | { decision: "process"; id: string | null; attempts: number }
  | { decision: "duplicate" | "dead" };

export async function claimEvent(store: LedgerStore, key: LedgerKey, nowMs = Date.now()): Promise<ClaimResult> {
  try {
    const { row, created } = await store.claim(key);
    const d = decideClaim(row, created, nowMs);
    if (d === "process") return { decision: "process", id: row.id, attempts: row.attempts };
    if (d === "duplicate" || d === "dead") return { decision: d };
    const taken = await store.reclaim(row);
    if (!taken) return { decision: "duplicate" };
    return { decision: "process", id: taken.id, attempts: taken.attempts };
  } catch (error) {
    console.error(JSON.stringify({ event: "voice_ledger_claim_failed_open", error: error instanceof Error ? error.message : String(error) }));
    return { decision: "process", id: null, attempts: 1 };
  }
}

export async function completeEvent(store: LedgerStore, id: string | null): Promise<void> {
  if (!id) return;
  try {
    await store.mark(id, { status: "processed", last_error: null });
  } catch (error) {
    console.error(JSON.stringify({ event: "voice_ledger_complete_failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Records a persistence failure. dead=true means retries are exhausted: answer 200 so the provider stops retrying. */
export async function failEvent(
  store: LedgerStore,
  id: string | null,
  attempts: number,
  error: string,
  payload: Record<string, unknown>,
): Promise<{ dead: boolean }> {
  const dead = attempts >= MAX_ATTEMPTS;
  if (id) {
    try {
      await store.mark(id, { status: dead ? "dead" : "failed", last_error: error.slice(0, 500), payload });
    } catch (e) {
      console.error(JSON.stringify({ event: "voice_ledger_fail_mark_failed", error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return { dead };
}

/** Minimal, non-sensitive facts kept for replay (never transcript / recording URL). */
export function buildReplayPayload(p: {
  callerPhone: string | null; callerName: string | null; durationSeconds: number | null; summary: string | null; endedReason: string | null;
}): Record<string, unknown> {
  return {
    caller_phone: p.callerPhone,
    caller_name: p.callerName,
    duration_seconds: typeof p.durationSeconds === "number" && Number.isFinite(p.durationSeconds) ? Math.max(0, Math.round(p.durationSeconds)) : null,
    summary: p.summary ? p.summary.slice(0, 2000) : null,
    ended_reason: p.endedReason,
  };
}

// ---- Supabase adapter (structural type: no npm import so tests can run in vitest) ----------------
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminLike = { from(table: string): any };
const TABLE = "voice_webhook_events";
const COLS = "id, status, attempts, updated_at";

export function supabaseLedgerStore(admin: AdminLike): LedgerStore {
  return {
    async claim(key) {
      const ins = await admin
        .from(TABLE)
        .insert({ user_id: key.userId, vapi_call_id: key.vapiCallId, event_type: key.eventType, status: "processing", attempts: 1 })
        .select(COLS)
        .maybeSingle();
      if (!ins.error && ins.data) return { row: ins.data as LedgerRow, created: true };
      if (ins.error && ins.error.code !== "23505") throw new Error(ins.error.message ?? "ledger insert failed");
      const sel = await admin.from(TABLE).select(COLS).eq("vapi_call_id", key.vapiCallId).eq("event_type", key.eventType).maybeSingle();
      if (sel.error || !sel.data) throw new Error(sel.error?.message ?? "ledger row not found after conflict");
      return { row: sel.data as LedgerRow, created: false };
    },
    async reclaim(row) {
      const upd = await admin
        .from(TABLE)
        .update({ status: "processing", attempts: row.attempts + 1 })
        .eq("id", row.id)
        .eq("status", row.status)
        .eq("attempts", row.attempts)
        .select(COLS)
        .maybeSingle();
      if (upd.error) throw new Error(upd.error.message ?? "ledger reclaim failed");
      return (upd.data as LedgerRow | null) ?? null;
    },
    async mark(id, patch) {
      const { error } = await admin.from(TABLE).update(patch).eq("id", id);
      if (error) throw new Error(error.message ?? "ledger update failed");
    },
  };
}
