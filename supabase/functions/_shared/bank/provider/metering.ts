// supabase/functions/_shared/bank/provider/metering.ts
//
// Per-pull cost metering. Every provider call is recorded with its operation, units, duration and
// outcome. Cost is stored in integer MICRO-USD (1 USD = 1_000_000) because a single pull costs far
// less than one cent and Vireek's rule is "integer money, never floats".
//
// NO RATES ARE SHIPPED. What a vendor charges per call / per connected item is contract-specific
// [VERIFY]. Until finance inserts a row in bank_provider_rates, `costMicros` is NULL — "unknown" —
// never 0, so dashboards cannot present a made-up number as a fact.

import type { MeteredOperation, ProviderId } from "./types.ts";

export interface PullRecord {
  userId: string | null;
  connectionId: string | null;
  provider: ProviderId;
  operation: MeteredOperation;
  units: number;
  status: "ok" | "error" | "blocked";
  errorKind: string | null;
  durationMs: number;
  costMicros: number | null;
}

/** Integer micro-USD for `units` at `rateMicrosPerUnit`; null when the rate is unknown. */
export function computeCostMicros(units: number, rateMicrosPerUnit: number | null): number | null {
  if (rateMicrosPerUnit === null || !Number.isFinite(rateMicrosPerUnit) || rateMicrosPerUnit < 0) return null;
  if (!Number.isInteger(units) || units < 0) return null;
  const v = units * rateMicrosPerUnit;
  return Number.isSafeInteger(v) ? v : null;
}

/** Blocked calls never reached the vendor, so they cost exactly nothing (a known 0, not unknown). */
export function costForStatus(status: PullRecord["status"], units: number, rate: number | null): number | null {
  return status === "blocked" ? 0 : computeCostMicros(units, rate);
}

export interface UsageSummary {
  calls: number;
  errors: number;
  blocked: number;
  knownCostMicros: number;
  callsWithUnknownCost: number;
}

export function summarize(records: readonly PullRecord[]): UsageSummary {
  const s: UsageSummary = { calls: 0, errors: 0, blocked: 0, knownCostMicros: 0, callsWithUnknownCost: 0 };
  for (const r of records) {
    s.calls++;
    if (r.status === "error") s.errors++;
    if (r.status === "blocked") s.blocked++;
    if (r.costMicros === null) s.callsWithUnknownCost++;
    else s.knownCostMicros += r.costMicros;
  }
  return s;
}
