// supabase/functions/_shared/interpreter/governor.ts
//
// The rules that decide, turn by turn, whether to relay, read back, re-ask or
// stop — and the latency budget that decides when live audio is no longer worth
// it and the call degrades to text captions.
//
// What "added latency" means here (so the number can be audited):
//   from the moment the ASR delivers a FINAL transcript of a party's utterance
//   to the moment the first sample of translated audio is sent to the listener.
//   Speech-endpointing silence (how long we wait to decide someone stopped
//   talking) is reported separately as `endpointing_ms` and is NOT in this number.

import type { InterpLang } from "./languages.ts";

export const THRESHOLDS = {
  /** ASR confidence at or above which an utterance is trusted. */
  asrTrusted: 0.8,
  /** Below this, the utterance is not relayed at all: re-ask. */
  asrFloor: 0.55,
  /** Translator self-reported confidence floor. */
  mtFloor: 0.7,
  /** Floor for safety-relevant staff instructions and anything with critical data. */
  mtSafetyFloor: 0.9,
  /** Consecutive re-asks of the same party before stopping live interpretation. */
  maxReasks: 2,
  p50BudgetMs: 700,
  p95BudgetMs: 1500,
  /** Samples needed before the budget is enforced (avoids degrading on a cold-start turn). */
  minSamples: 4,
  window: 20,
  endpointingMs: 300,
} as const;

export type TurnAction = "relay" | "relay_with_readback" | "reask" | "handoff";

export interface TurnInput {
  asrConfidence: number | null;
  mtConfidence: number | null;
  hasCritical: boolean;
  criticalOk: boolean;
  unparsedNumerals: boolean;
  safetyRelevant: boolean;
  emergency: boolean;
  /** Re-asks already made of THIS party in a row. */
  reasks: number;
  textEmpty: boolean;
}

export interface TurnDecision {
  action: TurnAction;
  reason: string;
}

/**
 * Pure policy. Order matters: an emergency is never held back by a confidence
 * rule — it is relayed immediately and a human takes over.
 */
export function decideTurn(i: TurnInput): TurnDecision {
  if (i.emergency) return { action: "relay", reason: "emergency" };
  const stuck = i.reasks >= THRESHOLDS.maxReasks;
  const fail = (reason: string): TurnDecision => (stuck ? { action: "handoff", reason: `${reason}_after_reasks` } : { action: "reask", reason });

  if (i.textEmpty) return fail("empty");
  if (i.asrConfidence !== null && i.asrConfidence < THRESHOLDS.asrFloor) return fail("asr_low");
  if (i.asrConfidence !== null && i.asrConfidence < THRESHOLDS.asrTrusted && (i.hasCritical || i.unparsedNumerals || i.safetyRelevant)) {
    return fail("asr_medium_with_critical");
  }
  if (i.unparsedNumerals && !i.hasCritical) return fail("unparsed_numerals");
  if (!i.criticalOk) return fail("critical_mismatch");
  if (i.mtConfidence !== null) {
    const floor = i.safetyRelevant || i.hasCritical ? THRESHOLDS.mtSafetyFloor : THRESHOLDS.mtFloor;
    if (i.mtConfidence < floor) return fail("mt_low");
  }
  return i.hasCritical ? { action: "relay_with_readback", reason: "critical_data" } : { action: "relay", reason: "ok" };
}

// ---------------------------------------------------------------- latency
export type BudgetStatus = "warming" | "ok" | "degraded";

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/**
 * Rolling window of added-latency samples with hysteresis:
 *   degrade  when p50 > budget (or p95 > p95 budget) over >= minSamples
 *   recover  only when p50 <= 85% of budget over >= 6 samples since degrading
 */
export class LatencyBudget {
  private samples: number[] = [];
  private sinceDegrade: number[] = [];
  private state: BudgetStatus = "warming";

  private readonly p50Budget: number;
  private readonly p95Budget: number;
  private readonly window: number;

  constructor(p50Budget: number = THRESHOLDS.p50BudgetMs, p95Budget: number = THRESHOLDS.p95BudgetMs, window: number = THRESHOLDS.window) {
    this.p50Budget = p50Budget;
    this.p95Budget = p95Budget;
    this.window = window;
  }

  record(addedMs: number): BudgetStatus {
    if (!Number.isFinite(addedMs) || addedMs < 0) return this.state;
    this.samples.push(addedMs);
    if (this.samples.length > this.window) this.samples.shift();
    if (this.state === "degraded") {
      this.sinceDegrade.push(addedMs);
      if (this.sinceDegrade.length >= 6 && percentile(this.sinceDegrade.slice(-this.window), 50) <= this.p50Budget * 0.85) {
        this.state = "ok";
        this.sinceDegrade = [];
      }
      return this.state;
    }
    if (this.samples.length >= THRESHOLDS.minSamples) {
      this.state = percentile(this.samples, 50) > this.p50Budget || percentile(this.samples, 95) > this.p95Budget ? "degraded" : "ok";
      if (this.state === "degraded") this.sinceDegrade = [];
    }
    return this.state;
  }

  status(): BudgetStatus {
    return this.state;
  }
  p50(): number {
    return percentile(this.samples, 50);
  }
  p95(): number {
    return percentile(this.samples, 95);
  }
  count(): number {
    return this.samples.length;
  }
}

// ------------------------------------------------------------------- modes
export type InterpMode = "assistant" | "bridge_consecutive" | "bridge_simultaneous" | "captions";

/**
 * Effective bridge mode. Simultaneous is only used when asked for AND the
 * measured latency has earned it; degraded latency always falls to captions.
 */
export function effectiveMode(requested: InterpMode, budget: BudgetStatus, p95Ms: number): InterpMode {
  if (requested === "assistant" || requested === "captions") return requested;
  if (budget === "degraded") return "captions";
  if (requested === "bridge_simultaneous" && !(budget === "ok" && p95Ms <= 1200)) return "bridge_consecutive";
  return requested;
}

export function isInterpreted(lang: InterpLang | null): lang is Exclude<InterpLang, "en"> {
  return lang !== null && lang !== "en";
}
