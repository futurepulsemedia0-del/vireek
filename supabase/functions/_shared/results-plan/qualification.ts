// Results Plan — verified booked job qualification (pure, no I/O).
// Definition version is published on the methodology page. Every number below is a PLACEHOLDER
// until the owner approves it (see RESULTS_PLAN_DEFAULTS).

export const RESULTS_PLAN_RULE_VERSION = 'rp-rules-v1';

export type VerificationLevel = 'none' | 'booked' | 'confirmed' | 'completed' | 'paid';
export const LEVEL_ORDER: readonly VerificationLevel[] = ['none', 'booked', 'confirmed', 'completed', 'paid'];

export type JobSource = 'sarah' | 'owner' | 'crm_import' | 'test' | 'unknown';
export type ContactChannel = 'call' | 'sms' | 'chat';
export type JobStatus = 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled';

export type ReasonCode =
  | 'not_first_contact_by_sarah'
  | 'owner_created'
  | 'internal_test'
  | 'spam'
  | 'wrong_number'
  | 'duplicate'
  | 'rework'
  | 'existing_open_job'
  | 'cancelled_before_billing_event'
  | 'voided_by_cancellation_window'
  | 'conflicting_signals'
  | 'invalid_timestamp'
  | 'below_billing_level';

export interface RulesConfig {
  /** Level at which a job becomes billable. Recommended: 'completed'. */
  billingLevel: Exclude<VerificationLevel, 'none'>;
  /** No billing when the same customer/address has an OPEN job created within this many days. */
  existingWorkWindowDays: number;
  /** Same customer/address booked again within this many hours counts as a duplicate. */
  duplicateWindowHours: number;
  /** A cancellation within this many hours AFTER the billing event voids the charge. */
  cancelWindowHours: number;
  /**
   * Optional safety net for owners who never mark completion: a CONFIRMED job that is not cancelled becomes billable
   * at the 'confirmed' level this many days after confirmation. null = off.
   */
  confirmedFallbackDays: number | null;
}

/** PLACEHOLDERS — not approved. Do not treat as final policy. */
export const RESULTS_PLAN_DEFAULTS: RulesConfig = {
  billingLevel: 'completed',
  existingWorkWindowDays: 30,
  duplicateWindowHours: 24,
  cancelWindowHours: 72,
  confirmedFallbackDays: null,
};

export interface JobFacts {
  id: string;
  customerKey: string | null;
  addressKey: string | null;
  createdAt: string;
  source: JobSource;
  status: JobStatus;
  /** A rework/callback visit for earlier work is never billed as a new job. */
  isRework?: boolean;
  confirmedAt?: string | null;
  completedAt?: string | null;
  paidAt?: string | null;
  cancelledAt?: string | null;
}

export interface ContactFacts {
  handledBySarah: boolean;
  channel: ContactChannel | null;
  isSpam: boolean;
  isWrongNumber: boolean;
}

export interface PriorJob {
  id: string;
  customerKey: string | null;
  addressKey: string | null;
  createdAt: string;
  status: JobStatus;
}

export interface QualificationResult {
  ruleVersion: string;
  qualified: boolean;
  level: VerificationLevel;
  billable: boolean;
  voided: boolean;
  billableAt: string | null;
  /** Level the charge was billed at (differs from the configured level only for the confirmed fallback). */
  billedAtLevel: Exclude<VerificationLevel, 'none'> | null;
  viaFallback: boolean;
  reasons: ReasonCode[];
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function ts(value: string | null | undefined): number | null | 'bad' {
  if (value === null || value === undefined || value === '') return null;
  const n = Date.parse(value);
  return Number.isNaN(n) ? 'bad' : n;
}

function sameParty(a: { customerKey: string | null; addressKey: string | null }, b: { customerKey: string | null; addressKey: string | null }): boolean {
  return (a.customerKey !== null && a.customerKey === b.customerKey) || (a.addressKey !== null && a.addressKey === b.addressKey);
}

export function levelAtLeast(level: VerificationLevel, min: VerificationLevel): boolean {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(min);
}

export function qualifyJob(
  job: JobFacts,
  contact: ContactFacts,
  priorJobs: readonly PriorJob[],
  config: RulesConfig = RESULTS_PLAN_DEFAULTS,
  nowIso?: string
): QualificationResult {
  const reasons: ReasonCode[] = [];
  const base = { ruleVersion: RESULTS_PLAN_RULE_VERSION, billableAt: null as string | null, billedAtLevel: null as QualificationResult['billedAtLevel'], viaFallback: false };
  const nowMs = Date.parse(nowIso ?? new Date().toISOString());

  const created = ts(job.createdAt);
  const confirmed = ts(job.confirmedAt);
  const completed = ts(job.completedAt);
  const paid = ts(job.paidAt);
  const cancelled = ts(job.cancelledAt);
  if ([created, confirmed, completed, paid, cancelled].includes('bad') || created === null) {
    return { ...base, qualified: false, level: 'none', billable: false, voided: false, reasons: ['invalid_timestamp'] };
  }
  const createdMs = created as number;

  // (a) first meaningful contact handled by Sarah
  if (!contact.handledBySarah || contact.channel === null) reasons.push('not_first_contact_by_sarah');
  // (c) exclusions
  if (job.source === 'owner' || job.source === 'crm_import') reasons.push('owner_created');
  if (job.source === 'test') reasons.push('internal_test');
  if (contact.isSpam) reasons.push('spam');
  if (contact.isWrongNumber) reasons.push('wrong_number');
  if (job.isRework) reasons.push('rework');

  // duplicate: an EARLIER non-cancelled job for the same party inside the duplicate window
  const dupMs = config.duplicateWindowHours * HOUR_MS;
  const existingMs = config.existingWorkWindowDays * DAY_MS;
  let duplicate = false;
  let existingOpen = false;
  for (const p of priorJobs) {
    if (p.id === job.id || !sameParty(job, p)) continue;
    const pc = ts(p.createdAt);
    if (pc === null || pc === 'bad' || pc > createdMs) continue; // only earlier jobs
    const age = createdMs - pc;
    if (p.status !== 'cancelled' && age <= dupMs) duplicate = true;
    // (b) open job (not completed / cancelled) within N days => existing work, never billed
    if ((p.status === 'scheduled' || p.status === 'en_route' || p.status === 'in_progress') && age <= existingMs) existingOpen = true;
  }
  if (duplicate) reasons.push('duplicate');
  if (existingOpen && !duplicate) reasons.push('existing_open_job');

  const qualified = reasons.length === 0;

  // verification level reached (by evidence, not by status label)
  let level: VerificationLevel = 'booked';
  if (confirmed !== null) level = 'confirmed';
  if (completed !== null) level = 'completed';
  if (paid !== null) level = 'paid';

  // conflicting signals: cancelled BEFORE the job shows completion/payment -> human review, never billed
  const doneAt = completed !== null ? completed : paid;
  if (cancelled !== null && doneAt !== null && (cancelled as number) < (doneAt as number)) reasons.push('conflicting_signals');
  if (reasons.includes('conflicting_signals')) {
    return { ...base, qualified: false, level, billable: false, voided: false, reasons };
  }
  if (!qualified) return { ...base, qualified: false, level, billable: false, voided: false, reasons };

  const eventTimes: Record<Exclude<VerificationLevel, 'none'>, number | null> = {
    booked: createdMs,
    confirmed: confirmed as number | null,
    completed: completed as number | null,
    paid: paid as number | null,
  };
  const order = LEVEL_ORDER.slice(1) as Array<Exclude<VerificationLevel, 'none'>>;
  const from = order.indexOf(config.billingLevel);
  let eventAt: number | null = null;
  for (const l of order.slice(from)) {
    if (eventTimes[l] !== null) {
      eventAt = eventTimes[l];
      break;
    }
  }

  if (cancelled !== null && (eventAt === null || (cancelled as number) < eventAt)) {
    return { ...base, qualified: true, level: 'none', billable: false, voided: false, reasons: ['cancelled_before_billing_event'] };
  }
  if (eventAt === null || !levelAtLeast(level, config.billingLevel)) {
    // Safety net for owners who never mark completion: confirmed + not cancelled + waiting period elapsed.
    if (
      config.confirmedFallbackDays !== null &&
      (config.billingLevel === 'completed' || config.billingLevel === 'paid') &&
      confirmed !== null &&
      cancelled === null &&
      !Number.isNaN(nowMs)
    ) {
      const at = (confirmed as number) + config.confirmedFallbackDays * DAY_MS;
      if (at <= nowMs) {
        return { ...base, qualified: true, level, billable: true, voided: false, billableAt: new Date(at).toISOString(), billedAtLevel: 'confirmed', viaFallback: true, reasons: [] };
      }
    }
    return { ...base, qualified: true, level, billable: false, voided: false, reasons: ['below_billing_level'] };
  }
  if (cancelled !== null && (cancelled as number) - eventAt <= config.cancelWindowHours * HOUR_MS) {
    return { ...base, qualified: true, level, billable: false, voided: true, billableAt: new Date(eventAt).toISOString(), billedAtLevel: config.billingLevel, reasons: ['voided_by_cancellation_window'] };
  }
  return { ...base, qualified: true, level, billable: true, voided: false, billableAt: new Date(eventAt).toISOString(), billedAtLevel: config.billingLevel, reasons: [] };
}
