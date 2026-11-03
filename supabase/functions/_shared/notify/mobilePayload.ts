// supabase/functions/_shared/notify/mobilePayload.ts
// Pure (no I/O) rules for mobile push: severity, privacy-safe lock-screen text, action category,
// Android channel, iOS interruption level, haptic pattern. Unit tested in mobilePayload.test.ts.

export type Severity = "critical" | "high" | "normal" | "low";

export interface MobileNotifInput {
  type: string;
  title: string;
  message: string;
}

export interface MobilePrefs {
  hide_customer_names: boolean;
  time_sensitive_enabled: boolean;
}

export const DEFAULT_PREFS: MobilePrefs = { hide_customer_names: true, time_sensitive_enabled: true };

export interface MobilePayload {
  title: string;
  body: string;
  severity: Severity;
  category: string; // iOS category + Android action set id (handled natively)
  androidChannel: string;
  interruptionLevel: "time-sensitive" | "active" | "passive";
  haptic: "emergency" | "urgent" | "default" | "none";
}

const SEVERITY_BY_TYPE: Record<string, Severity> = {
  emergency_call: "critical",
  on_call: "high",
  missed_call: "high",
  payment_failed: "high",
  payment_request: "normal",
  job: "normal",
  job_update: "normal",
  job_summary: "low",
};

const CATEGORY_BY_TYPE: Record<string, string> = {
  emergency_call: "EMERGENCY_CALL",
  missed_call: "MISSED_CALL",
  job: "JOB",
  job_update: "JOB",
};

const GENERIC_BODY: Record<string, string> = {
  emergency_call: "New emergency call. Open Vireek for details.",
  missed_call: "You have a missed call. Open Vireek for details.",
  payment_failed: "A payment needs attention.",
  payment_request: "A payment is pending.",
  job: "Job update. Open Vireek for details.",
  job_update: "Job update. Open Vireek for details.",
};

export function severityFor(type: string): Severity {
  return SEVERITY_BY_TYPE[type] ?? "normal";
}

/** Only the types listed in GENERIC_BODY are redacted; every other type keeps today's text unchanged. */
export function buildMobilePayload(n: MobileNotifInput, prefs: MobilePrefs = DEFAULT_PREFS): MobilePayload {
  const severity = severityFor(n.type);
  const hide = prefs.hide_customer_names && n.type in GENERIC_BODY;
  const title = hide ? (n.type === "emergency_call" ? "Emergency call" : "Vireek") : n.title;
  const body = hide ? GENERIC_BODY[n.type] : n.message;
  const urgent = severity === "critical" || severity === "high";
  return {
    title,
    body,
    severity,
    category: CATEGORY_BY_TYPE[n.type] ?? "DEFAULT",
    androidChannel: `vireek_${severity}`,
    // Time-sensitive only if the user allows it. Critical Alerts are NOT used (entitlement not requested).
    interruptionLevel: urgent && prefs.time_sensitive_enabled ? "time-sensitive" : severity === "low" ? "passive" : "active",
    haptic: severity === "critical" ? "emergency" : severity === "high" ? "urgent" : severity === "low" ? "none" : "default",
  };
}

/** "1.4.0" >= "1.3.2". False when either side is missing/malformed, so a feature gate fails closed. */
export function versionAtLeast(version: string | null | undefined, min: string | null | undefined): boolean {
  if (!version || !min) return false;
  const a = version.split(".").map((x) => Number.parseInt(x, 10));
  const b = min.split(".").map((x) => Number.parseInt(x, 10));
  if ([...a, ...b].some((n) => Number.isNaN(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
