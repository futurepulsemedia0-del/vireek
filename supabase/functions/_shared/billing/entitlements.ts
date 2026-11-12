// supabase/functions/_shared/billing/entitlements.ts
//
// Server-enforced plan entitlements: the ONE source of truth for seat / location / number / call / SMS /
// retention limits and for which plan unlocks which feature.
//
// Pure module: no imports, no Deno globals, no I/O. It is unit-tested by Vitest, imported by edge functions,
// and re-exported to the browser by src/lib/planLimits.ts (so client and server can never drift).
// The database enforces the same table: the JSON literal in plan_limit_table() inside
// supabase/migrations/20290303000000_plan_entitlements.sql is compared to PLAN_LIMITS / FEATURE_MIN_PLAN
// by entitlements.test.ts, so a change here that is not mirrored in SQL fails CI.
//
// Not to be confused with src/lib/entitlements.ts (per-account MODULE switches: pay, ai, supply ...).
// Related: ./planCatalog.ts (what can be bought in Stripe), ../fraud/planLimits.ts (abuse / cost caps).

export const PLAN_TIERS = ["free", "starter", "professional", "business", "enterprise"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/** null = no fixed limit (enterprise: the contract value may be stored in profiles.custom_limits). */
export type Limit = number | null;

export interface PlanLimitRow {
  seats: Limit;
  locations: Limit;
  phoneNumbers: Limit;
  concurrentCalls: Limit;
  smsPerMonth: Limit;
  transcriptRetentionDays: Limit;
  recordingsEnabled: boolean;
}

export const PLAN_LIMITS: Readonly<Record<PlanTier, Readonly<PlanLimitRow>>> = {
  free: { seats: 1, locations: 1, phoneNumbers: 1, concurrentCalls: 1, smsPerMonth: 20, transcriptRetentionDays: 7, recordingsEnabled: false },
  starter: { seats: 2, locations: 1, phoneNumbers: 1, concurrentCalls: 2, smsPerMonth: 300, transcriptRetentionDays: 30, recordingsEnabled: false },
  professional: { seats: 5, locations: 1, phoneNumbers: 2, concurrentCalls: 5, smsPerMonth: 900, transcriptRetentionDays: 365, recordingsEnabled: true },
  business: { seats: 15, locations: 3, phoneNumbers: 3, concurrentCalls: 10, smsPerMonth: 2500, transcriptRetentionDays: 730, recordingsEnabled: true },
  enterprise: { seats: null, locations: null, phoneNumbers: null, concurrentCalls: null, smsPerMonth: 8000, transcriptRetentionDays: null, recordingsEnabled: true },
};

/** Limits that can be raised with purchased add-ons (profiles.extra_*) or, on enterprise, a contract override. */
export const COUNTED_KEYS = ["seats", "locations", "phoneNumbers", "concurrentCalls"] as const;
export type CountedKey = (typeof COUNTED_KEYS)[number];

/** Every key the limit table knows (numeric ones). recordingsEnabled is a boolean and handled separately. */
export const NUMERIC_KEYS = [...COUNTED_KEYS, "smsPerMonth", "transcriptRetentionDays"] as const;
export type NumericKey = (typeof NUMERIC_KEYS)[number];

/** profiles column that holds purchased extras for each counted key. */
export const EXTRA_COLUMN: Readonly<Record<CountedKey, string>> = {
  seats: "extra_users",
  locations: "extra_locations",
  phoneNumbers: "extra_numbers",
  concurrentCalls: "extra_concurrent",
};

/** Lowest plan that includes each feature. emergencyDetectionSms is on every plan. */
export const FEATURE_MIN_PLAN = {
  emergencyDetectionSms: "free",
  warmTransfer: "professional",
  emergencyLiveDispatch: "professional",
  afterHoursRouting: "professional",
  outboundCalling: "professional",
  dispatchBoard: "professional",
  priceBook: "professional",
  agreements: "professional",
  reviewRequests: "professional",
  multiLocation: "business",
  advancedAnalytics: "business",
  roleBasedAccess: "business",
  inventory: "business",
  accountingSync: "business",
  payrollConnectors: "business",
  whiteLabel: "business",
  biExport: "business",
  basicWebhooks: "business",
  franchise: "enterprise",
  fullApi: "enterprise",
  sso: "enterprise",
  auditLogs: "enterprise",
  customVoice: "enterprise",
} as const satisfies Record<string, PlanTier>;

export type FeatureKey = keyof typeof FEATURE_MIN_PLAN;
export const FEATURE_KEYS = Object.keys(FEATURE_MIN_PLAN) as FeatureKey[];

// ---------------------------------------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------------------------------------

export const isPlanTier = (v: unknown): v is PlanTier => typeof v === "string" && (PLAN_TIERS as readonly string[]).includes(v);
export const tierRank = (t: PlanTier): number => PLAN_TIERS.indexOf(t);

export interface TierInput {
  /** profiles.plan */
  plan: string | null | undefined;
  /** profiles.stripe_subscription_id */
  stripeSubscriptionId?: string | null;
  /** profiles.plan_tier_override: lets ops pin a tier (offline-billed accounts). Wins over everything. */
  tierOverride?: string | null;
}

/**
 * Which row of PLAN_LIMITS applies to an account.
 *
 * WHY the starter special case: profiles.plan defaults to 'starter' in the database and the UI treats
 * 'starter' as the free plan (UpgradeBanner FREE_PLAN_ID), while the Stripe webhook also writes 'starter'
 * for the paid Starter plan. A 'starter' account with NO Stripe subscription is therefore a trial / free
 * account. Offline-billed Starter accounts must be pinned with plan_tier_override = 'starter'.
 * Unknown or missing plan => 'free' (most restrictive), same rule as fraud/planLimits.normalizePlan().
 * Mirrors plan_effective_tier() in SQL.
 */
export function resolveTier({ plan, stripeSubscriptionId, tierOverride }: TierInput): PlanTier {
  if (isPlanTier(tierOverride)) return tierOverride;
  if (!isPlanTier(plan)) return "free";
  if (plan === "starter" && !(stripeSubscriptionId ?? "").trim()) return "free";
  return plan;
}

// ---------------------------------------------------------------------------------------------------------
// Effective limits
// ---------------------------------------------------------------------------------------------------------

export interface Extras {
  extraUsers?: number | null;
  extraLocations?: number | null;
  extraNumbers?: number | null;
  extraConcurrent?: number | null;
}

export type CustomLimits = Partial<Record<NumericKey, number | null>> | null | undefined;

const EXTRA_FIELD: Readonly<Record<CountedKey, keyof Extras>> = {
  seats: "extraUsers",
  locations: "extraLocations",
  phoneNumbers: "extraNumbers",
  concurrentCalls: "extraConcurrent",
};

/** A usable non-negative whole number, otherwise 0 (a corrupt extra can never reduce or break a limit). */
export function safeExtra(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Effective limit = plan base + purchased extras, or (enterprise only) the contract value in custom_limits.
 * Returns null for "no fixed limit". A null base never gets extras (unlimited stays unlimited).
 */
export function effectiveLimit(tier: PlanTier, key: NumericKey, opts: { extras?: Extras; customLimits?: CustomLimits } = {}): Limit {
  const base = PLAN_LIMITS[tier][key];
  if (tier === "enterprise" && opts.customLimits && Object.prototype.hasOwnProperty.call(opts.customLimits, key)) {
    const c = opts.customLimits[key];
    if (c === null) return null;
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return Math.floor(c);
    // anything else (string, negative, NaN) is ignored: fall through to the plan base
  }
  if (base === null) return null;
  if ((COUNTED_KEYS as readonly string[]).includes(key)) {
    return base + safeExtra(opts.extras?.[EXTRA_FIELD[key as CountedKey]]);
  }
  return base;
}

/** Effective cap when two independent systems both cap the same resource (entitlement vs fraud): the stricter wins. */
export function strictestLimit(a: Limit, b: Limit): Limit {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export function recordingsAllowed(tier: PlanTier): boolean {
  return PLAN_LIMITS[tier].recordingsEnabled;
}

export function hasFeature(tier: PlanTier, feature: FeatureKey): boolean {
  return tierRank(tier) >= tierRank(FEATURE_MIN_PLAN[feature]);
}

// ---------------------------------------------------------------------------------------------------------
// Addition checks + typed error
// ---------------------------------------------------------------------------------------------------------

export interface AdditionCheck {
  allowed: boolean;
  /** The account already uses more than its limit (an older plan, a downgrade or a lowered limit): only NEW additions are blocked. */
  grandfathered: boolean;
}

/**
 * Whether `adding` more units fit. Never touches what exists: an account already over its limit keeps
 * everything it has (grandfathered) and is only refused further additions.
 */
export function checkAddition(limit: Limit, current: number, adding = 1): AdditionCheck {
  if (limit === null) return { allowed: true, grandfathered: false };
  const cur = Math.max(0, Math.floor(current));
  return { allowed: cur + Math.max(0, adding) <= limit, grandfathered: cur > limit };
}

/** The cheapest plan whose BASE limit would admit `needed` units; null when only a custom contract can. */
export function upgradeTarget(key: NumericKey, needed: number, from: PlanTier): PlanTier | null {
  for (const t of PLAN_TIERS) {
    if (tierRank(t) <= tierRank(from)) continue;
    const base = PLAN_LIMITS[t][key];
    if (base === null || base >= needed) return t;
  }
  return null;
}

export function featureUpgradeTarget(feature: FeatureKey, from: PlanTier): PlanTier | null {
  const min: PlanTier = FEATURE_MIN_PLAN[feature];
  return tierRank(min) > tierRank(from) ? min : null;
}

export interface PlanLimitError {
  code: "PLAN_LIMIT";
  /** A NumericKey for a count limit, a FeatureKey for a locked feature, or 'recordings'. */
  key: string;
  /** The effective limit (0 for a locked feature). null is never returned for an error. */
  limit: number;
  current: number;
  /** Cheapest plan that fixes it, or null when only an add-on / enterprise contract can (talk to sales). */
  upgradeTo: PlanTier | null;
}

export function planLimitError(key: string, limit: number, current: number, upgradeTo: PlanTier | null): PlanLimitError {
  return { code: "PLAN_LIMIT", key, limit, current, upgradeTo };
}

export function isPlanLimitError(v: unknown): v is PlanLimitError {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return e.code === "PLAN_LIMIT" && typeof e.key === "string" && typeof e.limit === "number" && typeof e.current === "number"
    && (e.upgradeTo === null || isPlanTier(e.upgradeTo));
}

/**
 * Full decision for adding one unit of a counted resource. Pure: the caller supplies the tier, extras and the
 * live count. The database trigger runs the same arithmetic atomically (plan_enforce_limit).
 */
export function evaluateAddition(input: {
  tier: PlanTier;
  key: CountedKey;
  current: number;
  extras?: Extras;
  customLimits?: CustomLimits;
  /** Independent cap from another system (e.g. fraud maxNumbers); the stricter of the two applies. */
  externalCap?: Limit;
  adding?: number;
}): { allowed: boolean; grandfathered: boolean; limit: Limit; error: PlanLimitError | null } {
  const adding = input.adding ?? 1;
  const limit = strictestLimit(effectiveLimit(input.tier, input.key, { extras: input.extras, customLimits: input.customLimits }), input.externalCap ?? null);
  const r = checkAddition(limit, input.current, adding);
  if (r.allowed || limit === null) return { ...r, limit, error: null };
  return { ...r, limit, error: planLimitError(input.key, limit, Math.max(0, Math.floor(input.current)), upgradeTarget(input.key, input.current + adding, input.tier)) };
}

export function featureDecision(tier: PlanTier, feature: FeatureKey): { allowed: boolean; error: PlanLimitError | null } {
  if (hasFeature(tier, feature)) return { allowed: true, error: null };
  return { allowed: false, error: planLimitError(feature, 0, 0, featureUpgradeTarget(feature, tier)) };
}
