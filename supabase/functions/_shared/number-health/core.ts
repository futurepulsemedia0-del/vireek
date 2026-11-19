// supabase/functions/_shared/number-health/core.ts
//
// Number reputation monitoring: pure logic + the provider-agnostic adapter contract + a stub adapter.
// No imports and no Deno/browser APIs, so the scheduled function, the dashboard and the unit tests share one file.
//
// HONESTY RULES (enforced by tests):
//  * The stub adapter NEVER invents a spam label or an attestation level: it reports "unknown".
//  * A provider that is not live is shown as "not connected" in the UI. Nothing is scored.
//  * We store what a provider reports (a label, an attestation level, the names of the sources that labelled the
//    number). We do not compute a reputation "score".
//
// [VERIFY] Real providers (carrier analytics vendors, Twilio Voice Integrity, etc.) each have their own API, naming and
// terms. Adding one means writing a NumberReputationAdapter for it and registering it in ADAPTER_FACTORIES at the
// bottom of the scheduled function. Nothing in this file assumes a specific vendor.

/* ------------------------------------------------------------------ */
/*  Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** Normalised spam-label state, whatever the provider calls it. */
export const SPAM_LABELS = ['clean', 'suspected', 'flagged', 'unknown'] as const;
export type SpamLabel = (typeof SPAM_LABELS)[number];

/**
 * STIR/SHAKEN attestation for calls originated from the number: A = the carrier vouches for the caller AND the number,
 * B = vouches for the caller but not the number, C = gateway (call entered the network from elsewhere). "unknown" means
 * the provider did not report it.
 */
export const ATTESTATION_LEVELS = ['A', 'B', 'C', 'unknown'] as const;
export type AttestationLevel = (typeof ATTESTATION_LEVELS)[number];

export type HealthSeverity = 'ok' | 'watch' | 'action' | 'unknown';
export type HealthStatus = 'never' | 'ok' | 'error';

export const MAX_LABEL_SOURCES = 5;
export const MAX_SOURCE_NAME = 40;
/** A result older than this is shown as out of date. */
export const STALE_AFTER_HOURS = 36;
/** Never ask the provider about the same number more often than this (cron and manual checks both obey it). */
export const MIN_RECHECK_MINUTES = 10;
/** The scheduled run only re-checks numbers whose last attempt is older than this. */
export const SCHEDULED_RECHECK_HOURS = 5;
export const BATCH_SIZE = 50;

export const E164_RE = /^\+[1-9][0-9]{6,14}$/;
export const isE164 = (s: unknown): s is string => typeof s === 'string' && E164_RE.test(s);

/* ------------------------------------------------------------------ */
/*  Adapter contract                                                    */
/* ------------------------------------------------------------------ */

export interface NumberHealthResult {
  /** E.164 number this result is about. */
  e164: string;
  spamLabel: SpamLabel;
  attestation: AttestationLevel;
  /** Names of the carriers / analytics sources that applied the label (short, max MAX_LABEL_SOURCES). */
  labelSources: string[];
}

export type AdapterErrorCode = 'rate_limited' | 'unauthorized' | 'provider_down' | 'bad_response' | 'timeout' | 'unsupported';

export type AdapterOutcome =
  | { ok: true; results: NumberHealthResult[] }
  | { ok: false; code: AdapterErrorCode; retryable: boolean };

/**
 * What a reputation provider must implement. Implementations must: never throw for provider errors (return ok:false),
 * honour `signal`, never log phone numbers, and only report values the provider actually returned.
 */
export interface NumberReputationAdapter {
  /** Stable id stored with every result, e.g. "stub". */
  readonly id: string;
  /** False for the stub: results are placeholders and the UI says no provider is connected. */
  readonly isLive: boolean;
  lookup(numbers: readonly string[], signal?: AbortSignal): Promise<AdapterOutcome>;
}

/** Placeholder adapter used until a real provider is registered. Optional fixtures exist for tests and demos only. */
export function createStubAdapter(fixtures: Readonly<Record<string, Partial<Omit<NumberHealthResult, 'e164'>>>> = {}): NumberReputationAdapter {
  return {
    id: 'stub',
    isLive: false,
    async lookup(numbers) {
      return {
        ok: true,
        results: numbers.map((e164) => {
          const f = fixtures[e164];
          return {
            e164,
            spamLabel: f?.spamLabel ?? 'unknown',
            attestation: f?.attestation ?? 'unknown',
            labelSources: sanitizeSources(f?.labelSources),
          };
        }),
      };
    },
  };
}

export type AdapterFactory = () => NumberReputationAdapter;

/** Picks the adapter named by config. An unknown id falls back to the stub and says so, instead of failing the whole run. */
export function resolveAdapter(
  requestedId: string | null | undefined,
  factories: Readonly<Record<string, AdapterFactory>>,
): { adapter: NumberReputationAdapter; fellBack: boolean } {
  const id = (requestedId ?? '').trim().toLowerCase() || 'stub';
  const make = Object.prototype.hasOwnProperty.call(factories, id) ? factories[id] : undefined;
  if (make) return { adapter: make(), fellBack: false };
  return { adapter: createStubAdapter(), fellBack: id !== 'stub' };
}

/* ------------------------------------------------------------------ */
/*  Normalisation (provider output -> our vocabulary)                    */
/* ------------------------------------------------------------------ */

export function normalizeSpamLabel(raw: unknown): SpamLabel {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (['clean', 'none', 'no_label', 'not_flagged'].includes(v)) return 'clean';
  if (['suspected', 'suspect', 'possible', 'spam_likely', 'likely', 'potential_spam', 'scam_likely', 'unwanted'].includes(v)) return 'suspected';
  if (['flagged', 'spam', 'fraud', 'scam', 'blocked', 'high_risk'].includes(v)) return 'flagged';
  return 'unknown';
}

export function normalizeAttestation(raw: unknown): AttestationLevel {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s_-]+/g, '') : '';
  if (['a', 'full', 'fullattestation', 'attestationa'].includes(v)) return 'A';
  if (['b', 'partial', 'partialattestation', 'attestationb'].includes(v)) return 'B';
  if (['c', 'gateway', 'gatewayattestation', 'attestationc'].includes(v)) return 'C';
  return 'unknown';
}

/** Keeps source names short, printable, unique and bounded: they come from third parties and are rendered in the UI. */
export function sanitizeSources(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const clean = item.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_NAME);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= MAX_LABEL_SOURCES) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Severity                                                            */
/* ------------------------------------------------------------------ */

export interface HealthView {
  spamLabel: SpamLabel;
  attestation: AttestationLevel;
  status: HealthStatus;
  /** Last SUCCESSFUL check. */
  checkedAt: Date | null;
}

/**
 * ok      = label clean and attestation not B/C
 * watch   = label suspected, or attestation B/C
 * action  = label flagged
 * unknown = never checked, provider returned nothing usable, or no label and no attestation
 * Staleness is reported separately (isStale) so an old "flagged" is never silently downgraded.
 */
export function severityOf(h: Pick<HealthView, 'spamLabel' | 'attestation'>): HealthSeverity {
  if (h.spamLabel === 'flagged') return 'action';
  if (h.spamLabel === 'suspected') return 'watch';
  if (h.attestation === 'B' || h.attestation === 'C') return 'watch';
  if (h.spamLabel === 'clean') return 'ok';
  return 'unknown';
}

export function isStale(checkedAt: Date | null, now: Date): boolean {
  if (!checkedAt) return false; // "never checked" is its own state, not "stale"
  return now.getTime() - checkedAt.getTime() > STALE_AFTER_HOURS * 3_600_000;
}

/* ------------------------------------------------------------------ */
/*  Remediation checklist                                               */
/* ------------------------------------------------------------------ */

/** Every step id the server will accept. Text for each lives in the i18n namespace under steps.<id>. */
export const REMEDIATION_STEP_IDS = [
  'pause_outbound',
  'check_registration',
  'review_call_patterns',
  'contact_carrier',
  'ask_relabel',
  'verify_attestation',
  'register_cnam',
  'connect_provider',
  'manual_check',
  'keep_monitoring',
] as const;
export type RemediationStepId = (typeof REMEDIATION_STEP_IDS)[number];

export const isStepId = (s: unknown): s is RemediationStepId => typeof s === 'string' && (REMEDIATION_STEP_IDS as readonly string[]).includes(s);

export interface RemediationInput {
  spamLabel: SpamLabel;
  attestation: AttestationLevel;
  providerLive: boolean;
}

/** Ordered steps for one number. Pure: same input, same list. */
export function buildRemediation(i: RemediationInput): RemediationStepId[] {
  if (!i.providerLive && i.spamLabel === 'unknown' && i.attestation === 'unknown') {
    return ['connect_provider', 'manual_check', 'register_cnam', 'check_registration'];
  }
  const steps: RemediationStepId[] = [];
  if (i.spamLabel === 'flagged') {
    steps.push('pause_outbound', 'check_registration', 'review_call_patterns', 'ask_relabel', 'contact_carrier');
  } else if (i.spamLabel === 'suspected') {
    steps.push('check_registration', 'review_call_patterns', 'ask_relabel');
  }
  if (i.attestation === 'B' || i.attestation === 'C') {
    steps.push('verify_attestation', 'register_cnam');
  }
  if (steps.length === 0) {
    return i.spamLabel === 'unknown' ? ['manual_check', 'check_registration'] : ['keep_monitoring'];
  }
  return [...new Set(steps)];
}

/** Share of a number's steps that are ticked (0-1). Unknown ids in `done` are ignored. */
export function remediationProgress(steps: readonly RemediationStepId[], done: Readonly<Record<string, boolean>> | null | undefined): { done: number; total: number } {
  const d = done ?? {};
  return { done: steps.filter((s) => d[s] === true).length, total: steps.length };
}

/* ------------------------------------------------------------------ */
/*  Scheduling + persistence decisions (pure)                            */
/* ------------------------------------------------------------------ */

export interface HealthRowState {
  spamLabel: SpamLabel;
  attestation: AttestationLevel;
  labelSources: string[];
  status: HealthStatus;
  checkedAt: Date | null;
  lastAttemptAt: Date | null;
  consecutiveFailures: number;
}

export const EMPTY_ROW: HealthRowState = {
  spamLabel: 'unknown', attestation: 'unknown', labelSources: [], status: 'never', checkedAt: null, lastAttemptAt: null, consecutiveFailures: 0,
};

export interface Candidate { id: string; e164: string; prev: HealthRowState | null }

/**
 * Numbers that should be looked up now. `force` (a manual "Check now") still honours MIN_RECHECK_MINUTES so the button
 * cannot be used to hammer a paid provider; the scheduled run waits SCHEDULED_RECHECK_HOURS. Never-checked numbers go
 * first, then the longest-waiting ones. Invalid E.164 numbers are skipped, never sent to a provider.
 */
export function selectDue(cands: readonly Candidate[], now: Date, force: boolean): { due: Candidate[]; skippedInvalid: number; skippedRecent: number } {
  const minMs = (force ? MIN_RECHECK_MINUTES * 60_000 : SCHEDULED_RECHECK_HOURS * 3_600_000);
  let skippedInvalid = 0;
  let skippedRecent = 0;
  const due: Candidate[] = [];
  for (const c of cands) {
    if (!isE164(c.e164)) { skippedInvalid++; continue; }
    const last = c.prev?.lastAttemptAt ?? null;
    if (last && now.getTime() - last.getTime() < minMs) { skippedRecent++; continue; }
    due.push(c);
  }
  due.sort((a, b) => (a.prev?.lastAttemptAt?.getTime() ?? 0) - (b.prev?.lastAttemptAt?.getTime() ?? 0));
  return { due, skippedInvalid, skippedRecent };
}

export interface ApplyResult {
  next: HealthRowState;
  /** Changes worth an audit-trail row. */
  changes: Array<{ kind: 'label_changed' | 'attestation_changed'; from: string; to: string }>;
}

/**
 * Folds one provider answer (or failure) into the stored row. On failure the last known label/attestation are KEPT (a
 * blip must not erase a "flagged"), the failure counter goes up, and checkedAt does not move, so staleness stays honest.
 * A number the provider did not answer for counts as a failure for that number.
 */
export function applyOutcome(prev: HealthRowState | null, answer: NumberHealthResult | null, now: Date): ApplyResult {
  const base = prev ?? EMPTY_ROW;
  if (!answer) {
    return { next: { ...base, status: 'error', lastAttemptAt: now, consecutiveFailures: Math.min(base.consecutiveFailures + 1, 1000) }, changes: [] };
  }
  const next: HealthRowState = {
    spamLabel: answer.spamLabel,
    attestation: answer.attestation,
    labelSources: sanitizeSources(answer.labelSources),
    status: 'ok',
    checkedAt: now,
    lastAttemptAt: now,
    consecutiveFailures: 0,
  };
  const changes: ApplyResult['changes'] = [];
  // Only record transitions between two real observations: the first ever result is not a "change".
  if (base.status === 'ok' || (base.checkedAt && base.spamLabel !== 'unknown')) {
    if (base.spamLabel !== next.spamLabel) changes.push({ kind: 'label_changed', from: base.spamLabel, to: next.spamLabel });
    if (base.attestation !== next.attestation) changes.push({ kind: 'attestation_changed', from: base.attestation, to: next.attestation });
  }
  return { next, changes };
}

/** Index a provider's results by number, ignoring anything we did not ask about or that is malformed. */
export function indexResults(asked: readonly string[], results: readonly NumberHealthResult[]): Map<string, NumberHealthResult> {
  const wanted = new Set(asked);
  const out = new Map<string, NumberHealthResult>();
  for (const r of results) {
    if (!r || !wanted.has(r.e164) || out.has(r.e164)) continue;
    out.set(r.e164, {
      e164: r.e164,
      spamLabel: SPAM_LABELS.includes(r.spamLabel) ? r.spamLabel : 'unknown',
      attestation: ATTESTATION_LEVELS.includes(r.attestation) ? r.attestation : 'unknown',
      labelSources: sanitizeSources(r.labelSources),
    });
  }
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
