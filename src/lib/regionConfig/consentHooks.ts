/* ------------------------------------------------------------------ */
/*  regionConfig/consentHooks — privacy-consent HOOKS (GDPR-style)      */
/*                                                                      */
/*  REQUIRES COUNSEL. These are extension points, not a compliance      */
/*  claim. They tell the app WHICH consent purposes a region's regimes  */
/*  usually make relevant (from the audited regionalPacks tables) and   */
/*  give integrators an idempotent event bus to record consent without  */
/*  hard-wiring any one provider. Whether a purpose/wording/basis is    */
/*  lawful is a question for the owner's counsel.                       */
/*                                                                      */
/*  Pure + in-memory. Persistence stays in the existing consent_records */
/*  flow (regime / basis / policy_version columns already exist).       */
/* ------------------------------------------------------------------ */

import { marketingRegimeFor, regimesFor, type RegimeId } from '../regionalPacks/packPrivacy';
import { COUNSEL_NOTICE } from './legalSlots';

export type ConsentPurpose = 'service_communications' | 'marketing_email' | 'marketing_sms' | 'call_recording' | 'analytics_cookies';
export type ConsentEventType = 'granted' | 'withdrawn' | 'access_requested' | 'erasure_requested';

export interface ConsentPurposeRule {
  purpose: ConsentPurpose;
  /** UI should present an explicit, unticked choice and keep evidence. A prompt, not a legal conclusion. */
  explicitChoiceSuggested: boolean;
  regimes: RegimeId[];
}

export interface ConsentRequirements {
  country: string;
  regimes: RegimeId[];
  purposes: ConsentPurposeRule[];
  requiresCounsel: true;
  notice: string;
}

const STRICT: ReadonlySet<RegimeId> = new Set<RegimeId>(['GDPR', 'UK_GDPR', 'CASL', 'QC_LAW25', 'AU_SPAM']);

export function consentRequirementsFor(country: string, subdivision?: string | null): ConsentRequirements {
  const cc = (country || '').toUpperCase();
  const regimes = regimesFor(cc, subdivision);
  const marketing = marketingRegimeFor(cc);
  const strict = regimes.filter((r) => STRICT.has(r));
  const all: ConsentPurpose[] = ['service_communications', 'marketing_email', 'marketing_sms', 'call_recording', 'analytics_cookies'];
  return {
    country: cc,
    regimes,
    purposes: all.map((purpose) => ({
      purpose,
      // Unknown country (no regimes) → suggest explicit choice: fail toward asking, never toward assuming consent.
      explicitChoiceSuggested: regimes.length === 0 ? purpose !== 'service_communications' : (purpose !== 'service_communications' && (strict.length > 0 || (marketing !== null && STRICT.has(marketing)))),
      regimes: regimes,
    })),
    requiresCounsel: true,
    notice: COUNSEL_NOTICE,
  };
}

export interface ConsentEvent {
  /** Caller-generated unique id (e.g. UUID). Re-delivering the same id is a no-op. */
  eventId: string;
  type: ConsentEventType;
  purpose: ConsentPurpose | null;
  /** Account owner id — every event is tenant-scoped. */
  accountOwnerId: string;
  subjectId: string;
  country: string;
  subdivision?: string | null;
  occurredAt: string; // ISO timestamp
  policyVersion?: string | null;
}

export interface ConsentHook { name: string; handle(e: ConsentEvent): Promise<void> | void }

export interface ConsentBus {
  register(hook: ConsentHook): () => void;
  emit(e: ConsentEvent): Promise<{ delivered: number; failed: { hook: string; error: string }[]; duplicate: boolean }>;
}

const EVENT_ID_RE = /^[A-Za-z0-9_.:\-]{8,128}$/;

export function createConsentBus(maxRemembered = 5000): ConsentBus {
  const hooks = new Map<string, ConsentHook>();
  const seen = new Set<string>();
  return {
    register(hook) {
      if (hooks.has(hook.name)) throw new Error(`Consent hook "${hook.name}" is already registered.`);
      hooks.set(hook.name, hook);
      return () => { hooks.delete(hook.name); };
    },
    async emit(e) {
      if (!EVENT_ID_RE.test(e.eventId)) throw new Error('Invalid consent eventId.');
      if (!e.accountOwnerId || !e.subjectId) throw new Error('Consent events require accountOwnerId and subjectId.');
      if (Number.isNaN(Date.parse(e.occurredAt))) throw new Error('Consent event occurredAt must be an ISO timestamp.');
      const key = `${e.accountOwnerId}:${e.eventId}`; // scoped per tenant: ids cannot collide across accounts
      if (seen.has(key)) return { delivered: 0, failed: [], duplicate: true };
      seen.add(key);
      if (seen.size > maxRemembered) seen.delete(seen.values().next().value as string);
      let delivered = 0; const failed: { hook: string; error: string }[] = [];
      for (const hook of [...hooks.values()]) {
        try { await hook.handle(e); delivered += 1; } // one failing hook never blocks the others
        catch (err) { failed.push({ hook: hook.name, error: err instanceof Error ? err.message : String(err) }); }
      }
      if (failed.length === hooks.size && hooks.size > 0) seen.delete(key); // nothing delivered → allow a retry
      return { delivered, failed, duplicate: false };
    },
  };
}
