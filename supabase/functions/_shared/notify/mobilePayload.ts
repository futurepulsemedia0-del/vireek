// supabase/functions/_shared/notify/mobilePayload.ts
// Pure (no I/O) rules for mobile push: severity, privacy-safe lock-screen text, action category,
// Android channel, iOS interruption level, haptic pattern. Unit tested in mobilePayload.test.ts.
import { resolveTier, tierFor, TIER_CONFIG, type SoundTier } from "./soundTiers.ts";
import { versionAtLeast } from "./versionAtLeast.ts";

export { versionAtLeast };
export type Severity = "critical" | "high" | "normal" | "low";

export interface MobileNotifInput {
  type: string;
  title: string;
  message: string;
}

export interface MobilePrefs {
  hide_customer_names: boolean;
  time_sensitive_enabled: boolean;
  /** Tiers whose sound the person switched off (user_mobile_surface_prefs.sound_off_tiers). */
  sound_off_tiers?: SoundTier[];
}

/** Per-device context. Unknown appVersion keeps the legacy Android channel ids (fails closed). */
export interface MobileDeviceContext {
  appVersion?: string | null;
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
  tier: SoundTier;
  /** "default" = system sound; null = omit `sound` from aps entirely. */
  iosSound: "default" | null;
  webSilent: boolean;

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

/** Derived from the sound tier, so the two can never disagree. Unknown types stay "normal". */
export function severityFor(type: string): Severity {
  return TIER_CONFIG[tierFor(type)].severity;
}

/** Only the types listed in GENERIC_BODY are redacted; every other type keeps today's text unchanged. */
export function buildMobilePayload(
  n: MobileNotifInput,
  prefs: MobilePrefs = DEFAULT_PREFS,
  device: MobileDeviceContext = {},
): MobilePayload {
  const tier = tierFor(n.type);
  const r = resolveTier(n.type, {
    appVersion: device.appVersion,
    soundOff: prefs.sound_off_tiers?.includes(tier) === true,
    timeSensitiveEnabled: prefs.time_sensitive_enabled,
  });
  const hide = prefs.hide_customer_names && n.type in GENERIC_BODY;
  const title = hide ? (n.type === "emergency_call" ? "Emergency call" : "Vireek") : n.title;
  const body = hide ? GENERIC_BODY[n.type] : n.message;
  return {
    title,
    body,
    severity: r.severity,
    category: CATEGORY_BY_TYPE[n.type] ?? "DEFAULT",
    androidChannel: r.androidChannel,
    // Time-sensitive only if the user allows it. Critical Alerts are NOT used (entitlement not requested).
    interruptionLevel: r.interruptionLevel,
    haptic: r.haptic,
    tier: r.tier,
    iosSound: r.iosSound,
    webSilent: r.webSilent,
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
