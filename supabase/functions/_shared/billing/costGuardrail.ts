// supabase/functions/_shared/billing/costGuardrail.ts
// Pure guardrail evaluation (no I/O, no imports). Emergency handling is NEVER restricted for cost reasons.

export interface GuardrailLimits {
  softCostUsd: number | null;
  hardCostUsd: number | null;
  maxCallSeconds: number | null;
}

export type GuardrailLevel = "ok" | "soft" | "hard";
export type GuardrailAction = "none" | "alert_owner" | "restrict_non_emergency";

export interface GuardrailResult {
  level: GuardrailLevel;
  action: GuardrailAction;
  minutesPct: number | null;
  minutesAlert: 80 | 90 | 100 | null;
  reasons: string[];
}

export function evaluateGuardrail(input: {
  usedMinutes: number;
  includedMinutes: number;
  monthCostUsd: number;
  limits: GuardrailLimits | null;
  isEmergency: boolean;
}): GuardrailResult {
  const { usedMinutes, includedMinutes, monthCostUsd, limits, isEmergency } = input;
  const reasons: string[] = [];
  const minutesPct = includedMinutes > 0 ? (usedMinutes / includedMinutes) * 100 : null;
  const minutesAlert = minutesPct === null ? null : minutesPct >= 100 ? 100 : minutesPct >= 90 ? 90 : minutesPct >= 80 ? 80 : null;
  if (minutesAlert) reasons.push(`minutes_${minutesAlert}pct`);

  let level: GuardrailLevel = "ok";
  if (limits?.softCostUsd != null && monthCostUsd >= limits.softCostUsd) { level = "soft"; reasons.push("soft_cost_limit"); }
  if (limits?.hardCostUsd != null && monthCostUsd >= limits.hardCostUsd) { level = "hard"; reasons.push("hard_cost_limit"); }

  let action: GuardrailAction = level === "hard" ? "restrict_non_emergency" : level === "soft" || minutesAlert ? "alert_owner" : "none";
  if (isEmergency) { action = "none"; reasons.push("emergency_never_restricted"); }
  return { level, action, minutesPct, minutesAlert, reasons };
}

/** Caps a call's duration; emergencies are never capped. null = no cap. */
export function effectiveMaxCallSeconds(limits: GuardrailLimits | null, isEmergency: boolean): number | null {
  if (isEmergency || !limits || limits.maxCallSeconds == null || limits.maxCallSeconds <= 0) return null;
  return limits.maxCallSeconds;
}
