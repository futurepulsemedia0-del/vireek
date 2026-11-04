// supabase/functions/_shared/voice-security/anomaly.ts
//
// Call-level anomaly detection. Weighted, probabilistic-OR scoring (same model as ai-core/aiSecurity.ts) over
// per-call counters kept server-side. Tenant-level detection only RECOMMENDS a mode change: an attacker who can
// place many hostile calls must not be able to auto-trip a tenant into lockdown (denial-of-service on the
// business), so tenant lockdown stays a human decision except for a confirmed canary hit.

export interface CallSignals {
  injection: number; //       injection-scanner hits on tool args
  denied: number; //          tool calls the gate refused
  unknown_tool: number; //    tools that are not in the catalog / voice_never
  cross_customer: number; //  attempts to read/act on another number's data
  verify_fail: number; //     failed OTP / known-details checks
  price_probe: number; //     lookup_price beyond the per-call allowance
  rate_limited: number; //    rate-limit refusals
  dropped_args: number; //    arguments the model sent that the policy does not allow
  multi_phone: number; //     distinct phone numbers supplied in one call (booking spam / SMS harassment)
  canary: number; //          canary / decoy touched
}

export const EMPTY_SIGNALS: Readonly<CallSignals> = Object.freeze({
  injection: 0, denied: 0, unknown_tool: 0, cross_customer: 0, verify_fail: 0, price_probe: 0, rate_limited: 0, dropped_args: 0, multi_phone: 0, canary: 0,
});

// weight = probability mass added per signal occurrence (capped by `cap` occurrences)
const WEIGHTS: { key: keyof CallSignals; weight: number; cap: number }[] = [
  { key: "canary", weight: 100, cap: 1 },
  { key: "cross_customer", weight: 45, cap: 2 },
  { key: "injection", weight: 30, cap: 3 },
  { key: "unknown_tool", weight: 30, cap: 2 },
  { key: "verify_fail", weight: 22, cap: 4 },
  { key: "rate_limited", weight: 18, cap: 3 },
  { key: "price_probe", weight: 15, cap: 3 },
  { key: "multi_phone", weight: 20, cap: 3 },
  { key: "denied", weight: 8, cap: 5 },
  { key: "dropped_args", weight: 6, cap: 3 },
];

export const THRESHOLDS = Object.freeze({ flag: 35, restrict: 60, lock: 90 });
export type AnomalyAction = "none" | "flag" | "restrict" | "lock";

export interface AnomalyVerdict { score: number; action: AnomalyAction; reasons: string[] }

export function scoreCall(signals: Partial<CallSignals>): AnomalyVerdict {
  let miss = 1;
  const reasons: string[] = [];
  for (const { key, weight, cap } of WEIGHTS) {
    const n = Math.min(signals[key] ?? 0, cap);
    if (n <= 0) continue;
    reasons.push(key);
    miss *= Math.pow(1 - Math.min(weight, 99.9) / 100, n);
  }
  if ((signals.canary ?? 0) > 0) miss = 0;
  const score = Math.round((1 - miss) * 100);
  const action: AnomalyAction = score >= THRESHOLDS.lock ? "lock" : score >= THRESHOLDS.restrict ? "restrict" : score >= THRESHOLDS.flag ? "flag" : "none";
  return { score, action, reasons };
}

export interface RecentHighRiskCall { callerHash: string; atMs: number; score: number; canary?: boolean }

export interface TenantRecommendation { action: "none" | "alert" | "recommend_restricted" | "recommend_lockdown"; reason: string }

/**
 * Looks at the last `windowMs` of high-risk calls for a tenant. Never changes anything by itself.
 *  - any canary hit            -> recommend_lockdown (data is being exfiltrated)
 *  - >=5 high-risk calls from >=3 distinct callers -> recommend_restricted (coordinated campaign)
 *  - >=3 high-risk calls       -> alert
 */
export function evaluateTenantWindow(calls: readonly RecentHighRiskCall[], nowMs: number, windowMs = 15 * 60_000): TenantRecommendation {
  const recent = calls.filter((c) => nowMs - c.atMs <= windowMs && c.score >= THRESHOLDS.restrict);
  if (recent.some((c) => c.canary)) return { action: "recommend_lockdown", reason: "canary_hit" };
  const distinct = new Set(recent.map((c) => c.callerHash)).size;
  if (recent.length >= 5 && distinct >= 3) return { action: "recommend_restricted", reason: "coordinated_high_risk_calls" };
  if (recent.length >= 3) return { action: "alert", reason: "repeated_high_risk_calls" };
  return { action: "none", reason: "normal" };
}
