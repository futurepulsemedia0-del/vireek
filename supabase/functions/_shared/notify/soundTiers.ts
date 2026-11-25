// supabase/functions/_shared/notify/soundTiers.ts
//
// ONE place that decides how a notification sounds and behaves. Pure (no I/O, no Deno APIs), used by
// mobilePayload.ts, send-push-notification, live-surface-dispatch and docs/notifications/sound-tiers.md
// (the doc table is generated from this file: scripts/notifications/gen-sound-tiers-doc.mjs).
//
// System sounds only: no custom audio asset exists anywhere. Android sound lives on the channel and is
// immutable after creation, so changing a sound means bumping the `_v2` suffix. iOS cannot pick a system
// sound by name: the only choices are "default" or no sound at all (omit the key). Critical Alerts are NOT used.

import { versionAtLeast } from "./versionAtLeast.ts";

export const SOUND_TIERS = ["emergency", "alert", "normal", "message", "quiet"] as const;
export type SoundTier = (typeof SOUND_TIERS)[number];

export function isSoundTier(v: unknown): v is SoundTier {
  return typeof v === "string" && (SOUND_TIERS as readonly string[]).includes(v);
}

export type IosInterruption = "time-sensitive" | "active" | "passive";
export type Haptic = "emergency" | "urgent" | "default" | "none";
export type AndroidImportance = "high" | "default" | "low";

export interface TierConfig {
  /** Android channel id (current generation). Must match VireekNotificationChannels.java. */
  androidChannel: string;
  /** Channel id older app builds know. Used for devices below ANDROID_V2_CHANNELS_MIN_VERSION. */
  legacyAndroidChannel: string;
  androidImportance: AndroidImportance;
  /** "default" = system default sound; null = no sound (the `sound` key is omitted from aps). */
  iosSound: "default" | null;
  /** "time-sensitive" is only used when the person's time_sensitive_enabled pref allows it, else "active". */
  interruptionLevel: IosInterruption;
  haptic: Haptic;
  /** Web Push `silent: true`. Web cannot choose a sound, so this is the only web control. */
  webSilent: boolean;
  /** Legacy severity vocabulary kept for the native `severity` data key and existing tests. */
  severity: "critical" | "high" | "normal" | "low";
}

export const TIER_CONFIG: Readonly<Record<SoundTier, TierConfig>> = {
  emergency: {
    androidChannel: "vireek_emergency_v2", legacyAndroidChannel: "vireek_critical", androidImportance: "high",
    iosSound: "default", interruptionLevel: "time-sensitive", haptic: "emergency", webSilent: false, severity: "critical",
  },
  alert: {
    androidChannel: "vireek_alert_v2", legacyAndroidChannel: "vireek_high", androidImportance: "high",
    iosSound: "default", interruptionLevel: "time-sensitive", haptic: "urgent", webSilent: false, severity: "high",
  },
  normal: {
    androidChannel: "vireek_normal_v2", legacyAndroidChannel: "vireek_normal", androidImportance: "default",
    iosSound: "default", interruptionLevel: "active", haptic: "default", webSilent: false, severity: "normal",
  },
  message: {
    androidChannel: "vireek_message_v2", legacyAndroidChannel: "vireek_normal", androidImportance: "default",
    iosSound: "default", interruptionLevel: "active", haptic: "default", webSilent: false, severity: "normal",
  },
  quiet: {
    androidChannel: "vireek_quiet_v2", legacyAndroidChannel: "vireek_low", androidImportance: "low",
    iosSound: null, interruptionLevel: "passive", haptic: "none", webSilent: true, severity: "low",
  },
};

/**
 * First app build that creates the `_v2` channels. Devices on an older (or unknown) version keep getting the
 * legacy channel ids, because FCM silently falls back to the default channel when channel_id does not exist
 * on the device. versionAtLeast() fails closed, so an unknown version always means "legacy".
 * [CONFIRM] set this to the versionName you actually ship with the new VireekNotificationChannels.java.
 */
export const ANDROID_V2_CHANNELS_MIN_VERSION = "1.1.0";

interface Group { tier: SoundTier; why: string; types: readonly string[] }

// Every type below was found by scripts/notifications/scanTypes.mjs or named in the original routing code.
// Anything not listed still falls back to "normal" at runtime, but soundTiers.test.mjs fails the build
// when the scanner finds a type that is missing here.
const GROUPS: readonly Group[] = [
  { tier: "emergency", why: "A live emergency call needs an answer now.", types: ["emergency_call"] },
  {
    tier: "alert", why: "Missed calls, on-call pages and payment failures lose money or trust if ignored.",
    types: ["on_call", "missed_call", "payment_failed", "speed_to_lead_handoff", "recurring_invoice_failed", "voice_resilience"],
  },
  {
    tier: "alert", why: "Security events: the person must see these even when they are not looking at the app.",
    types: ["security_alert"],
  },
  {
    tier: "alert", why: "Safety, recall and mass-incident events carry real-world risk.",
    types: ["safety_escalation", "safety_incident", "safety_decline", "vehicle_unsafe", "recall_alert", "mass_incident_alert"],
  },
  {
    tier: "alert", why: "A breached SLA, deadline or escalation needs action while it can still be fixed.",
    types: [
      "job_sla_breach", "lead_sla_breach", "rescue_sla_breach", "sla_escalation", "third_party_sla_breach",
      "commitment_escalation", "claim_escalated", "closeout_missed", "leak_case_overdue",
    ],
  },
  {
    tier: "normal", why: "Day-to-day job and money updates: audible but not intrusive.",
    types: [
      "job", "job_update", "payment_request", "new_lead", "quote_viewed", "job_hold_reminder", "parts_arrived",
      "parts_arrived_reschedule", "parts_delivered", "parts_order_cancelled", "parts_order_late", "parts_request",
      "third_party_work_order", "third_party_sla_risk", "closeout_deadline", "leak_case_due_soon", "truck_roll",
      "recurring_job_attention", "agent_booking_request", "agent_hold", "agent_hold_expiring",
    ],
  },
  {
    tier: "normal", why: "Account, plan, compliance and system notices: worth hearing once.",
    types: [
      "system", "usage_limit", "plan_limit", "api_usage_alert", "budget_alert", "warranty_alert", "warranty_claim_deadline",
      "contract_renewal_alert", "credential_expiry", "voice_clone_retention", "hr_review_due", "findings_response",
      "outcome_assurance", "service_guarantee", "survey_low_score", "technician_low_rating_alert",
      "technician_rating_trend_alert", "geofence_exit", "predictive_failure", "property_hazard", "ai_auto_reply",
      "service_recovery_signal",
    ],
  },
  { tier: "message", why: "Person-to-person conversation: a message sound, grouped by thread.", types: ["comment_mention", "comment_reply", "job_message", "chat_message"] },
  {
    tier: "quiet", why: "Summaries, insights and digests: visible in the shade, never a sound or buzz.",
    types: ["job_summary", "ai_insight", "prediction_mesh", "business_immune_signal", "property_intelligence", "service_twin", "feedback_update", "daily_briefing", "digest"],
  },
];

/** Dynamic type families (`prefix${kind}`) and the tier each family takes. */
export const TIER_BY_PREFIX: Readonly<Record<string, { tier: SoundTier; why: string }>> = {
  proactive_: { tier: "normal", why: "Proactive customer-alert candidates: informative, not urgent." },
  talent_: { tier: "normal", why: "Talent network events: informative, not urgent." },
};

export const TIER_BY_TYPE: Readonly<Record<string, SoundTier>> = Object.freeze(
  Object.fromEntries(GROUPS.flatMap((g) => g.types.map((t) => [t, g.tier] as const))),
);

export const TIER_RATIONALE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(GROUPS.flatMap((g) => g.types.map((t) => [t, g.why] as const))),
);

const PREFIXES = Object.keys(TIER_BY_PREFIX);

export function isKnownType(type: string): boolean {
  const t = type.toLowerCase();
  return t in TIER_BY_TYPE || PREFIXES.some((p) => t.startsWith(p));
}

/** Unknown types default to "normal" (today's behaviour). Never throws. */
export function tierFor(type: string): SoundTier {
  const t = String(type ?? "").toLowerCase();
  const direct = TIER_BY_TYPE[t];
  if (direct) return direct;
  const p = PREFIXES.find((x) => t.startsWith(x));
  return p ? TIER_BY_PREFIX[p].tier : "normal";
}

/** Strict allow-list parser for the per-person override column (ignores anything that is not a tier). */
export function parseSoundOffTiers(v: unknown): SoundTier[] {
  return Array.isArray(v) ? [...new Set(v.filter(isSoundTier))] : [];
}

export interface TierContext {
  /** device_push_tokens.app_version; unknown/null keeps the legacy Android channel. */
  appVersion?: string | null;
  /** Person muted this tier's sound (user_mobile_surface_prefs.sound_off_tiers). */
  soundOff?: boolean;
  /** user_mobile_surface_prefs.time_sensitive_enabled (defaults to true when omitted). */
  timeSensitiveEnabled?: boolean;
}

export interface ResolvedTier {
  tier: SoundTier;
  /** The tier whose configuration actually applies (a muted tier behaves as "quiet" on Android). */
  androidChannel: string;
  iosSound: "default" | null;
  interruptionLevel: IosInterruption;
  haptic: Haptic;
  webSilent: boolean;
  severity: TierConfig["severity"];
}

/**
 * Resolves what one device should receive. A person who switched a tier's sound off gets: iOS without `sound`,
 * web `silent: true`, and on Android the quiet channel (Android cannot mute a single message on a loud channel).
 * Interruption level stays as configured so a muted alert is still time-sensitive for Focus filtering.
 */
export function resolveTier(type: string, ctx: TierContext = {}): ResolvedTier {
  const tier = tierFor(type);
  const cfg = TIER_CONFIG[tier];
  const useV2 = versionAtLeast(ctx.appVersion, ANDROID_V2_CHANNELS_MIN_VERSION);
  const muted = ctx.soundOff === true && tier !== "quiet";
  const androidCfg = muted ? TIER_CONFIG.quiet : cfg;
  const tsAllowed = ctx.timeSensitiveEnabled !== false;
  return {
    tier,
    androidChannel: useV2 ? androidCfg.androidChannel : androidCfg.legacyAndroidChannel,
    iosSound: muted ? null : cfg.iosSound,
    interruptionLevel: cfg.interruptionLevel === "time-sensitive" && !tsAllowed ? "active" : cfg.interruptionLevel,
    haptic: muted ? "none" : cfg.haptic,
    webSilent: muted ? true : cfg.webSilent,
    severity: cfg.severity,
  };
}
