// supabase/functions/_shared/vertical-ai/telemetry.ts
//
// Structured event builders for the Vertical AI layer. They write into the EXISTING `call_trace_events` table via
// observability/recorder.ts recordTraceEvent (kind "lifecycle", name prefix "vai_"); no new observability stack.
// call_trace_events.attrs is capped at 2048 bytes and names at 64 chars; these builders keep to both and never
// put caller PII (transcripts, names, phone numbers, addresses) into attrs.

import type { SafetyFlag } from "./types.ts";

export type VaiEventName = "vai_emergency_override" | "vai_grounding_miss" | "vai_price_path" | "vai_handoff" | "vai_intake";

export interface VaiEvent {
  kind: "lifecycle";
  name: VaiEventName;
  ok: boolean | null;
  attrs: Record<string, unknown>;
}

const MAX_ATTR_BYTES = 1800;

function bounded(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (Array.isArray(v)) out[k] = v.slice(0, 12).map((x) => (typeof x === "string" ? x.slice(0, 64) : x));
    else out[k] = v;
  }
  // Last-resort guard for the table CHECK (pg_column_size(attrs) <= 2048).
  while (new TextEncoder().encode(JSON.stringify(out)).length > MAX_ATTR_BYTES) {
    const keys = Object.keys(out);
    if (keys.length === 0) break;
    delete out[keys[keys.length - 1]];
  }
  return out;
}

export const emergencyOverrideEvent = (a: { flags: SafetyFlag[]; rules: string[]; modelFlagged: boolean; source: string }): VaiEvent => ({
  kind: "lifecycle", name: "vai_emergency_override", ok: true,
  attrs: bounded({ flags: a.flags, rules: a.rules, model_flagged: a.modelFlagged, source: a.source }),
});

export const groundingMissEvent = (a: { type: string; reason: string }): VaiEvent => ({
  kind: "lifecycle", name: "vai_grounding_miss", ok: false, attrs: bounded({ type: a.type, reason: a.reason }),
});

export const pricePathEvent = (a: { status: string; path: string[]; candidates: number }): VaiEvent => ({
  kind: "lifecycle", name: "vai_price_path", ok: a.status === "resolved", attrs: bounded({ status: a.status, path: a.path, candidates: a.candidates }),
});

export const handoffEvent = (a: { reason: string; action: string | null }): VaiEvent => ({
  kind: "lifecycle", name: "vai_handoff", ok: null, attrs: bounded({ reason: a.reason, action: a.action }),
});

export const intakeEvent = (a: { trade: string | null; urgency: string; fields_missing: string[]; override: boolean }): VaiEvent => ({
  kind: "lifecycle", name: "vai_intake", ok: true, attrs: bounded({ trade: a.trade, urgency: a.urgency, fields_missing: a.fields_missing, override: a.override }),
});
