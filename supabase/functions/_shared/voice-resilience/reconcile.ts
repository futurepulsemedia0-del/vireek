// Reconciliation: provider call logs vs internal records. Pure diff + gap policy.

import type { ProviderCallRef } from "./providers.ts";

export interface InternalCallRef {
  /** vapi_call_id for engine calls, call_sid for carrier calls. */
  providerCallId: string;
  durationSeconds: number | null;
}

export interface DiffOptions {
  /** Calls younger than this are ignored (webhook may still be in flight). */
  graceMs: number;
  now: number;
  /** Provider calls shorter than this with no internal row are reported but not "recoverable" noise (e.g. instant hangups). */
  minDurationSeconds?: number;
}

export interface ReconcileDiff {
  /** Provider has it, we do not: recover. */
  missing: ProviderCallRef[];
  /** We have it, provider does not (outside the queried range): informational. */
  orphaned: InternalCallRef[];
  /** Both have it but durations differ materially. */
  durationMismatch: { providerCallId: string; providerSeconds: number; internalSeconds: number }[];
  /** Skipped because still in progress / inside grace. */
  skipped: number;
}

export function diffCalls(provider: ProviderCallRef[], internal: InternalCallRef[], o: DiffOptions): ReconcileDiff {
  const byId = new Map(internal.map((c) => [c.providerCallId, c]));
  const seen = new Set<string>();
  const missing: ProviderCallRef[] = [];
  const durationMismatch: ReconcileDiff["durationMismatch"] = [];
  let skipped = 0;

  for (const p of provider) {
    seen.add(p.providerCallId);
    const endedMs = p.endedAt ? Date.parse(p.endedAt) : NaN;
    const startedMs = p.startedAt ? Date.parse(p.startedAt) : NaN;
    const ref = Number.isFinite(endedMs) ? endedMs : startedMs;
    if (p.status !== "ended" || !Number.isFinite(ref) || o.now - ref < o.graceMs) { skipped += 1; continue; }
    const mine = byId.get(p.providerCallId);
    if (!mine) {
      if ((p.durationSeconds ?? 0) >= (o.minDurationSeconds ?? 0)) missing.push(p);
      else skipped += 1;
      continue;
    }
    if (p.durationSeconds != null && mine.durationSeconds != null && Math.abs(p.durationSeconds - mine.durationSeconds) > Math.max(5, p.durationSeconds * 0.1)) {
      durationMismatch.push({ providerCallId: p.providerCallId, providerSeconds: p.durationSeconds, internalSeconds: mine.durationSeconds });
    }
  }
  const orphaned = internal.filter((c) => !seen.has(c.providerCallId));
  return { missing, orphaned, durationMismatch, skipped };
}

export type GapSeverity = "none" | "warn" | "page";

/** Alert policy on a reconcile run. Any missing call after recovery attempts is at least a warning. */
export function gapSeverity(d: { missingBefore: number; unrecovered: number; compared: number }): GapSeverity {
  if (d.unrecovered > 0) return "page";
  if (d.missingBefore === 0) return "none";
  const rate = d.compared > 0 ? d.missingBefore / d.compared : 1;
  return rate >= 0.05 || d.missingBefore >= 5 ? "page" : "warn";
}

/**
 * Rebuild a Vapi `end-of-call-report` message from a GET /call/{id} object so the NORMAL webhook handler (with its
 * ledger/idempotency) processes the recovered call. NOT LIVE-VERIFIED against the current Vapi call object shape.
 */
export function toEndOfCallReport(call: Record<string, unknown>): Record<string, unknown> {
  const artifact = (call.artifact ?? {}) as Record<string, unknown>;
  const analysis = (call.analysis ?? {}) as Record<string, unknown>;
  const started = typeof call.startedAt === "string" ? Date.parse(call.startedAt) : NaN;
  const ended = typeof call.endedAt === "string" ? Date.parse(call.endedAt) : NaN;
  return {
    type: "end-of-call-report",
    call,
    phoneNumber: call.phoneNumber ?? (call.phoneNumberId ? { id: call.phoneNumberId } : undefined),
    endedReason: call.endedReason,
    transcript: artifact.transcript ?? call.transcript,
    summary: analysis.summary ?? call.summary,
    recordingUrl: artifact.recordingUrl ?? call.recordingUrl,
    artifact,
    analysis,
    durationSeconds: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? Math.round((ended - started) / 1000) : undefined,
    recovered_by: "voice-reconcile",
  };
}
