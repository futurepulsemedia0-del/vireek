// supabase/functions/_shared/fraud/anomaly.ts
//
// Pure anomaly detection over a recent window of outbound call events. The fraud-sweep cron loads the
// events and calls detectAnomalies(); thresholds are constants here so they are reviewable and tested.
//
// Signals: sudden international traffic, many very short calls, night-time spikes, repeated same-prefix
// destinations (IRSF number ranges), and spend velocity.

export type Severity = "low" | "medium" | "high";
export type RecommendedAction = "notify" | "throttle" | "suspend";

export interface CallEvent {
  /** Epoch ms when the call was placed. */
  at: number;
  /** ISO country, or "EMERGENCY". */
  country: string;
  international: boolean;
  /** null until the provider reports the call's duration (those calls are ignored by the short-call signal). */
  durationSeconds: number | null;
  /** First 7 digits of the E.164 number without '+' (country code + range). */
  prefix: string;
  costCents: number;
}

export interface AnomalyInput {
  now: number;
  events: readonly CallEvent[];
  /** Org UTC offset in minutes, to decide what "night" means for this business. */
  tzOffsetMinutes: number;
  dailyCostCap: number;
  /** International share of the org's calls over the previous 30 days (0..1); 0 if no history. */
  baselineInternationalShare: number;
}

export interface AnomalySignal {
  code: "INTERNATIONAL_SPIKE" | "SHORT_CALL_FLOOD" | "NIGHT_SPIKE" | "SAME_PREFIX_REPEAT" | "SPEND_VELOCITY";
  severity: Severity;
  detail: string;
  metric: number;
}

export interface AnomalyResult {
  signals: AnomalySignal[];
  action: RecommendedAction | null;
}

const HOUR = 3_600_000;
export const THRESHOLDS = {
  intlMinCalls: 5,
  intlShareHigh: 0.5,
  intlBaselineMax: 0.1,
  shortCallSeconds: 6,
  shortCallsMedium: 20,
  shortCallsHigh: 60,
  nightStartHour: 0,
  nightEndHour: 5,
  nightCallsMedium: 10,
  nightCallsHigh: 30,
  samePrefixMedium: 10,
  samePrefixHigh: 25,
  spendShareMedium: 0.5,
  spendShareHigh: 0.9,
} as const;

function localHour(at: number, tzOffsetMinutes: number): number {
  return new Date(at + tzOffsetMinutes * 60_000).getUTCHours();
}

export function detectAnomalies(input: AnomalyInput): AnomalyResult {
  const real = input.events.filter((e) => e.country !== "EMERGENCY"); // emergency traffic never raises a signal
  const hour = real.filter((e) => e.at > input.now - HOUR && e.at <= input.now);
  const quarter = real.filter((e) => e.at > input.now - HOUR / 4 && e.at <= input.now);
  const signals: AnomalySignal[] = [];

  // 1. International spike
  const intl = hour.filter((e) => e.international);
  if (intl.length >= THRESHOLDS.intlMinCalls && input.baselineInternationalShare <= THRESHOLDS.intlBaselineMax) {
    const share = intl.length / hour.length;
    if (share >= THRESHOLDS.intlShareHigh) {
      signals.push({ code: "INTERNATIONAL_SPIKE", severity: "high", metric: Number(share.toFixed(2)), detail: `${intl.length} of ${hour.length} calls in the last hour were international (baseline ${Math.round(input.baselineInternationalShare * 100)}%)` });
    } else {
      signals.push({ code: "INTERNATIONAL_SPIKE", severity: "medium", metric: Number(share.toFixed(2)), detail: `${intl.length} international calls in the last hour` });
    }
  }

  // 2. Many short calls
  const short = quarter.filter((e) => e.durationSeconds !== null && e.durationSeconds < THRESHOLDS.shortCallSeconds);
  if (short.length >= THRESHOLDS.shortCallsMedium) {
    signals.push({ code: "SHORT_CALL_FLOOD", severity: short.length >= THRESHOLDS.shortCallsHigh ? "high" : "medium", metric: short.length, detail: `${short.length} calls shorter than ${THRESHOLDS.shortCallSeconds}s in 15 minutes` });
  }

  // 3. Night spike (org-local time)
  const night = hour.filter((e) => {
    const h = localHour(e.at, input.tzOffsetMinutes);
    return h >= THRESHOLDS.nightStartHour && h < THRESHOLDS.nightEndHour;
  });
  if (night.length >= THRESHOLDS.nightCallsMedium) {
    signals.push({ code: "NIGHT_SPIKE", severity: night.length >= THRESHOLDS.nightCallsHigh ? "high" : "medium", metric: night.length, detail: `${night.length} outbound calls between 00:00 and 05:00 local time in the last hour` });
  }

  // 4. Same-prefix repetition
  const byPrefix = new Map<string, number>();
  for (const e of hour) byPrefix.set(e.prefix, (byPrefix.get(e.prefix) ?? 0) + 1);
  let topPrefix = "";
  let topCount = 0;
  for (const [p, n] of byPrefix) if (n > topCount) { topPrefix = p; topCount = n; }
  if (topCount >= THRESHOLDS.samePrefixMedium) {
    signals.push({ code: "SAME_PREFIX_REPEAT", severity: topCount >= THRESHOLDS.samePrefixHigh ? "high" : "medium", metric: topCount, detail: `${topCount} calls to the number range +${topPrefix}* in the last hour` });
  }

  // 5. Spend velocity
  const spend = hour.reduce((s, e) => s + e.costCents, 0);
  if (input.dailyCostCap > 0) {
    const share = spend / input.dailyCostCap;
    if (share >= THRESHOLDS.spendShareMedium) {
      signals.push({ code: "SPEND_VELOCITY", severity: share >= THRESHOLDS.spendShareHigh ? "high" : "medium", metric: Number(share.toFixed(2)), detail: `${spend}c spent in one hour = ${Math.round(share * 100)}% of the daily cap` });
    }
  }

  return { signals, action: recommend(signals) };
}

/** high+high => suspend; any high or two mediums => throttle; anything else => notify. */
export function recommend(signals: readonly AnomalySignal[]): RecommendedAction | null {
  if (signals.length === 0) return null;
  const highs = signals.filter((s) => s.severity === "high").length;
  const mediums = signals.filter((s) => s.severity === "medium").length;
  if (highs >= 2) return "suspend";
  if (highs >= 1 || mediums >= 2) return "throttle";
  return "notify";
}
