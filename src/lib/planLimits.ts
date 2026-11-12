// Client side of the plan-entitlement layer.
// The limit table itself lives in supabase/functions/_shared/billing/entitlements.ts and is re-exported here, so the
// browser and the edge functions can never disagree (the database copy is checked against it by the unit test).
// NOT the same as src/lib/entitlements.ts, which is the per-account MODULE switch (pay, ai, supply ...).
import {
  isPlanLimitError,
  FEATURE_MIN_PLAN,
  type PlanLimitError,
  type PlanTier,
} from '../../supabase/functions/_shared/billing/entitlements';

export * from '../../supabase/functions/_shared/billing/entitlements';

export const PLAN_LABELS: Readonly<Record<PlanTier, string>> = {
  free: 'Free',
  starter: 'Starter',
  professional: 'Professional',
  business: 'Business',
  enterprise: 'Enterprise',
};

const NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  seats: ['team seat', 'team seats'],
  locations: ['location', 'locations'],
  phoneNumbers: ['phone number', 'phone numbers'],
  concurrentCalls: ['concurrent call', 'concurrent calls'],
  smsPerMonth: ['text per month', 'texts per month'],
  transcriptRetentionDays: ['day of transcript history', 'days of transcript history'],
};

/** "advancedAnalytics" -> "Advanced analytics" */
export function featureLabel(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** User-safe sentence for a PLAN_LIMIT error. */
export function planLimitMessage(e: PlanLimitError): string {
  const target = e.upgradeTo ? ` Upgrade to ${PLAN_LABELS[e.upgradeTo]} to continue.` : ' Contact us to raise this limit.';
  if (Object.prototype.hasOwnProperty.call(FEATURE_MIN_PLAN, e.key)) return `${featureLabel(e.key)} is not included in your plan.${target}`;
  const noun = NOUNS[e.key];
  const what = noun ? `${e.limit} ${e.limit === 1 ? noun[0] : noun[1]}` : `${e.limit} of this`;
  return `Your plan allows ${what}.${target}`;
}

/** Thrown by API wrappers so callers keep the structured error instead of a flattened message. */
export class PlanLimitException extends Error {
  readonly detail: PlanLimitError;
  constructor(detail: PlanLimitError) {
    super(planLimitMessage(detail));
    this.name = 'PlanLimitException';
    this.detail = detail;
  }
}

/**
 * Recognises a plan-limit failure from: PlanLimitException, a PostgREST error raised by the database triggers
 * (message 'PLAN_LIMIT', details = JSON), or an edge-function body ({ error: {code:'PLAN_LIMIT',...} } or the object itself).
 */
export function parsePlanLimitError(err: unknown, depth = 0): PlanLimitError | null {
  if (!err || typeof err !== 'object' || depth > 1) return null;
  if (err instanceof PlanLimitException) return err.detail;
  if (isPlanLimitError(err)) return err;
  const o = err as { message?: unknown; details?: unknown; error?: unknown };
  if (o.message === 'PLAN_LIMIT' && typeof o.details === 'string') {
    try {
      const parsed: unknown = JSON.parse(o.details);
      if (isPlanLimitError(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return o.error && typeof o.error === 'object' ? parsePlanLimitError(o.error, depth + 1) : null;
}
