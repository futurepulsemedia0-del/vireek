// supabase/functions/_shared/workflow-compiler/event-registry.ts
//
// Phase 5 (pure core) for the INTERNAL domain-event backbone. The backbone already exists:
// business_activity_events (immutable, aggregate_version per aggregate). This file adds the
// missing decision logic only: schema compatibility, per-aggregate ordered delivery,
// backpressure levels, DLQ retry/replay planning. It never touches the outbound webhook path.

export type FieldType = "string" | "number" | "boolean" | "object" | "array";
export interface EventSchema { fields: Record<string, { type: FieldType; required?: boolean }> }

const typeOf = (v: unknown): FieldType | "null" | "other" =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "object" ? (typeof v as FieldType) : "other";

export function validatePayload(schema: EventSchema, payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return ["payload must be an object"];
  const p = payload as Record<string, unknown>;
  const errs: string[] = [];
  for (const [k, f] of Object.entries(schema.fields)) {
    if (p[k] === undefined) { if (f.required) errs.push(`missing required field "${k}"`); continue; }
    if (typeOf(p[k]) !== f.type) errs.push(`field "${k}" must be ${f.type}`);
  }
  return errs;
}

/** Backward compatible = every consumer written for `old` still works on `next`. Empty array = compatible. */
export function compatibilityErrors(old: EventSchema, next: EventSchema): string[] {
  const errs: string[] = [];
  for (const [k, f] of Object.entries(old.fields)) {
    const n = next.fields[k];
    if (!n) errs.push(`field "${k}" was removed`);
    else if (n.type !== f.type) errs.push(`field "${k}" changed type ${f.type} -> ${n.type}`);
    else if (n.required && !f.required) errs.push(`field "${k}" became required`);
  }
  for (const [k, n] of Object.entries(next.fields)) if (!old.fields[k] && n.required) errs.push(`new field "${k}" must be optional`);
  return errs;
}

export function dedupeKey(eventType: string, aggregateId: string, aggregateVersion: number): string {
  if (![eventType, aggregateId].every((s) => s.length > 0 && !s.includes("|")) || !Number.isInteger(aggregateVersion) || aggregateVersion < 1) throw new Error("invalid dedupe key parts");
  return `${eventType}|${aggregateId}|${aggregateVersion}`;
}

export interface Pending { id: string; aggregate_id: string; aggregate_version: number }
/**
 * Per-aggregate, gap-free, in-order delivery for one consumer group.
 * `committed[agg]` = last version this group finished. Only version committed+1 is deliverable, one per aggregate;
 * anything already processed is a duplicate to ack-and-skip; a version further ahead is blocked until the gap fills.
 */
export function planDelivery(pending: readonly Pending[], committed: ReadonlyMap<string, number>): { deliver: Pending[]; duplicates: Pending[]; blocked: Pending[] } {
  const deliver: Pending[] = [], duplicates: Pending[] = [], blocked: Pending[] = [];
  const seen = new Set<string>();
  for (const e of [...pending].sort((a, b) => a.aggregate_id.localeCompare(b.aggregate_id) || a.aggregate_version - b.aggregate_version)) {
    const last = committed.get(e.aggregate_id) ?? 0;
    if (e.aggregate_version <= last) duplicates.push(e);
    else if (e.aggregate_version === last + 1 && !seen.has(e.aggregate_id)) { deliver.push(e); seen.add(e.aggregate_id); }
    else blocked.push(e);
  }
  return { deliver, duplicates, blocked };
}

export interface BackpressureConfig { warnDepth: number; shedDepth: number; warnAgeMs: number; shedAgeMs: number }
export type PressureLevel = "ok" | "warn" | "shed";
export function pressure(depth: number, oldestAgeMs: number, c: BackpressureConfig): PressureLevel {
  if (depth >= c.shedDepth || oldestAgeMs >= c.shedAgeMs) return "shed";
  if (depth >= c.warnDepth || oldestAgeMs >= c.warnAgeMs) return "warn";
  return "ok";
}

export interface RetryConfig { maxAttempts: number; baseMs: number; capMs: number }
/** Exponential backoff, capped. `jitter01` in [0,1) is injected so the result stays deterministic and testable. */
export function nextRetry(attempt: number, c: RetryConfig, jitter01 = 0): { action: "retry"; delayMs: number } | { action: "dead_letter" } {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt starts at 1");
  if (attempt >= c.maxAttempts) return { action: "dead_letter" };
  const exp = Math.min(c.capMs, c.baseMs * 2 ** (attempt - 1));
  return { action: "retry", delayMs: Math.floor(exp * (0.5 + 0.5 * Math.min(0.999999, Math.max(0, jitter01)))) };
}

export interface DeadLetter { id: string; event_type: string; failed_at: string; replayed_at?: string | null }
/** Replay selection: never re-offers an already replayed entry, bounded batch, oldest first. */
export function planReplay(dead: readonly DeadLetter[], opts: { types?: readonly string[]; since?: string; maxBatch: number }): DeadLetter[] {
  const max = Math.min(Math.max(1, Math.floor(opts.maxBatch)), 500);
  return dead.filter((d) => !d.replayed_at && (!opts.types || opts.types.includes(d.event_type)) && (!opts.since || d.failed_at >= opts.since))
    .sort((a, b) => a.failed_at.localeCompare(b.failed_at) || a.id.localeCompare(b.id)).slice(0, max);
}

export function isExpired(createdAtIso: string, nowMs: number, retentionDays: number): boolean {
  return nowMs - Date.parse(createdAtIso) > retentionDays * 86_400_000;
}
