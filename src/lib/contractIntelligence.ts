// Vireek Service Contract Intelligence — pure, deterministic engine.
//
// The AI only EXTRACTS terms from a contract (edge function
// contract-intelligence-extract). Every coverage / billing / deadline decision
// below is rule-based on purpose: a billing verdict must be consistent,
// explainable and auditable, never an LLM guess. No I/O in this file.

export type Priority = 'emergency' | 'urgent' | 'standard';
export type ClockType = 'calendar' | 'business';
export type Responsibility = 'contractor' | 'customer' | 'shared';
export type PartsResponsibility = Responsibility | 'warranty_only';
export type PenaltyType = 'none' | 'percent_of_invoice' | 'flat_cents' | 'percent_of_monthly_fee';
export type EscalationType = 'none' | 'fixed_percent' | 'cpi';
export type ExclusionKind = 'service_type' | 'equipment_type' | 'keyword';
export type Verdict = 'covered' | 'partially_covered' | 'not_covered' | 'needs_review';
export type BillingAction = 'do_not_bill' | 'bill_parts_only' | 'bill_labor_only' | 'bill_customer' | 'review';
export type ResponseStatus = 'pending' | 'met' | 'breached' | 'not_applicable';

export const ENGINE_VERSION = 1;

export interface ExclusionRule {
  kind: ExclusionKind;
  value: string;
}

export interface ContractTerms {
  sla: {
    clock: ClockType;
    timezone: string;
    business_days: number[]; // 0 = Sunday … 6 = Saturday
    business_start: string; // HH:MM
    business_end: string; // HH:MM
    response_emergency_minutes: number | null;
    response_urgent_minutes: number | null;
    response_standard_minutes: number | null;
    resolution_hours: number | null;
    penalty_type: PenaltyType;
    penalty_amount: number | null; // percent, or cents for flat_cents
    penalty_interval_minutes: number | null; // penalty repeats per started interval late
  };
  coverage: {
    all_assets: boolean;
    equipment_types: string[];
    service_types: string[]; // empty = every service type
    exclusions: ExclusionRule[];
    after_hours_covered: boolean;
  };
  responsibility: {
    labor: Responsibility;
    parts: PartsResponsibility;
    per_visit_cap_cents: number | null;
  };
  warranty: { labor_months: number | null; parts_months: number | null; notes: string };
  renewal: { auto_renew: boolean | null; notice_days: number | null; term_months: number | null };
  pricing: {
    escalation_type: EscalationType;
    escalation_percent: number | null;
    escalation_cap_percent: number | null;
    next_escalation_date: string | null; // YYYY-MM-DD
  };
  compliance: { requirements: string[] };
}

export interface EvidenceItem {
  field: string;
  quote: string;
}

// ---------------------------------------------------------------------------
// Normalisation (used for AI output AND for anything read back from the DB)
// ---------------------------------------------------------------------------

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}

export function emptyTerms(timezone: string = defaultTimezone()): ContractTerms {
  return {
    sla: {
      clock: 'calendar',
      timezone,
      business_days: [1, 2, 3, 4, 5],
      business_start: '08:00',
      business_end: '17:00',
      response_emergency_minutes: null,
      response_urgent_minutes: null,
      response_standard_minutes: null,
      resolution_hours: null,
      penalty_type: 'none',
      penalty_amount: null,
      penalty_interval_minutes: null,
    },
    coverage: { all_assets: true, equipment_types: [], service_types: [], exclusions: [], after_hours_covered: true },
    responsibility: { labor: 'customer', parts: 'customer', per_visit_cap_cents: null },
    warranty: { labor_months: null, parts_months: null, notes: '' },
    renewal: { auto_renew: null, notice_days: null, term_months: null },
    pricing: { escalation_type: 'none', escalation_percent: null, escalation_cap_percent: null, next_escalation_date: null },
    compliance: { requirements: [] },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, max = 300): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function int(v: unknown, min: number, max: number): number | null {
  const n = num(v, min, max);
  return n === null ? null : Math.round(n);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function list(v: unknown, maxItems = 40, maxLen = 200): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const item of v) {
    const s = str(item, maxLen);
    if (s) seen.add(s);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validTimezone(tz: unknown, fallback: string): string {
  if (typeof tz !== 'string' || !tz) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

export function normalizeTerms(raw: unknown, timezone: string = defaultTimezone()): ContractTerms {
  const base = emptyTerms(timezone);
  if (!isObj(raw)) return base;
  const sla = isObj(raw.sla) ? raw.sla : {};
  const cov = isObj(raw.coverage) ? raw.coverage : {};
  const res = isObj(raw.responsibility) ? raw.responsibility : {};
  const war = isObj(raw.warranty) ? raw.warranty : {};
  const ren = isObj(raw.renewal) ? raw.renewal : {};
  const pri = isObj(raw.pricing) ? raw.pricing : {};
  const com = isObj(raw.compliance) ? raw.compliance : {};

  const days = Array.isArray(sla.business_days)
    ? [...new Set((sla.business_days as unknown[]).map((d) => int(d, 0, 6)).filter((d): d is number => d !== null))].sort()
    : [];

  const penaltyType = oneOf(sla.penalty_type, ['none', 'percent_of_invoice', 'flat_cents', 'percent_of_monthly_fee'] as const, 'none');
  const penaltyAmount = penaltyType === 'flat_cents' ? int(sla.penalty_amount, 0, 1_000_000_000) : num(sla.penalty_amount, 0, 100);

  const exclusions: ExclusionRule[] = [];
  if (Array.isArray(cov.exclusions)) {
    for (const e of cov.exclusions.slice(0, 40)) {
      if (!isObj(e)) continue;
      const value = str(e.value, 120);
      if (value) exclusions.push({ kind: oneOf(e.kind, ['service_type', 'equipment_type', 'keyword'] as const, 'keyword'), value });
    }
  }

  return {
    sla: {
      clock: oneOf(sla.clock, ['calendar', 'business'] as const, base.sla.clock),
      timezone: validTimezone(sla.timezone, timezone),
      business_days: days.length ? days : base.sla.business_days,
      business_start: typeof sla.business_start === 'string' && HHMM.test(sla.business_start) ? sla.business_start : base.sla.business_start,
      business_end: typeof sla.business_end === 'string' && HHMM.test(sla.business_end) ? sla.business_end : base.sla.business_end,
      response_emergency_minutes: int(sla.response_emergency_minutes, 1, 60 * 24 * 30),
      response_urgent_minutes: int(sla.response_urgent_minutes, 1, 60 * 24 * 30),
      response_standard_minutes: int(sla.response_standard_minutes, 1, 60 * 24 * 30),
      resolution_hours: int(sla.resolution_hours, 1, 24 * 365),
      penalty_type: penaltyType,
      penalty_amount: penaltyType === 'none' ? null : penaltyAmount,
      penalty_interval_minutes: int(sla.penalty_interval_minutes, 1, 60 * 24 * 30),
    },
    coverage: {
      all_assets: typeof cov.all_assets === 'boolean' ? cov.all_assets : base.coverage.all_assets,
      equipment_types: list(cov.equipment_types, 40, 80),
      service_types: list(cov.service_types, 40, 80),
      exclusions,
      after_hours_covered: typeof cov.after_hours_covered === 'boolean' ? cov.after_hours_covered : base.coverage.after_hours_covered,
    },
    responsibility: {
      labor: oneOf(res.labor, ['contractor', 'customer', 'shared'] as const, base.responsibility.labor),
      parts: oneOf(res.parts, ['contractor', 'customer', 'shared', 'warranty_only'] as const, base.responsibility.parts),
      per_visit_cap_cents: int(res.per_visit_cap_cents, 0, 1_000_000_000),
    },
    warranty: { labor_months: int(war.labor_months, 0, 600), parts_months: int(war.parts_months, 0, 600), notes: str(war.notes, 500) },
    renewal: {
      auto_renew: typeof ren.auto_renew === 'boolean' ? ren.auto_renew : null,
      notice_days: int(ren.notice_days, 0, 730),
      term_months: int(ren.term_months, 1, 600),
    },
    pricing: {
      escalation_type: oneOf(pri.escalation_type, ['none', 'fixed_percent', 'cpi'] as const, 'none'),
      escalation_percent: num(pri.escalation_percent, 0, 100),
      escalation_cap_percent: num(pri.escalation_cap_percent, 0, 100),
      next_escalation_date: typeof pri.next_escalation_date === 'string' && DATE.test(pri.next_escalation_date) ? pri.next_escalation_date : null,
    },
    compliance: { requirements: list(com.requirements, 30, 200) },
  };
}

export function normalizeEvidence(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceItem[] = [];
  for (const e of raw.slice(0, 60)) {
    if (!isObj(e)) continue;
    const field = str(e.field, 60);
    const quote = str(e.quote, 400);
    if (field && quote) out.push({ field, quote });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timezone-aware business-hours clock
// ---------------------------------------------------------------------------

interface Zoned {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  dow: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(ts: number, tz: string): Zoned {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ts))) p[part.type] = part.value;
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, dow: dows.indexOf(p.weekday) };
}

function tzOffsetMs(ts: number, tz: string): number {
  const z = zonedParts(ts, tz);
  return Date.UTC(z.y, z.m - 1, z.d, z.h, z.min) - Math.floor(ts / 60000) * 60000;
}

/** Local wall-clock time in `tz` → UTC epoch ms (handles DST). */
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

const toMin = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3);

export function isWithinCoverage(ts: number, sla: ContractTerms['sla']): boolean {
  if (sla.clock === 'calendar') return true;
  const z = zonedParts(ts, sla.timezone);
  const mod = z.h * 60 + z.min;
  return sla.business_days.includes(z.dow) && mod >= toMin(sla.business_start) && mod < toMin(sla.business_end);
}

/** Add `minutes` of covered time to `startTs`, skipping closed hours/days. */
export function addCoveredMinutes(startTs: number, minutes: number, sla: ContractTerms['sla']): number {
  if (sla.clock === 'calendar') return startTs + minutes * 60000;
  const open = toMin(sla.business_start);
  const close = toMin(sla.business_end);
  if (close <= open || sla.business_days.length === 0) return startTs + minutes * 60000;

  let cursor = startTs;
  let remaining = minutes;
  for (let guard = 0; guard < 800 && remaining > 0; guard++) {
    const z = zonedParts(cursor, sla.timezone);
    const mod = z.h * 60 + z.min;
    if (sla.business_days.includes(z.dow) && mod >= open && mod < close) {
      const take = Math.min(remaining, close - mod);
      cursor += take * 60000;
      remaining -= take;
      continue;
    }
    // Jump to the next opening instant strictly after `cursor`.
    let next = Infinity;
    for (let i = 0; i <= 8; i++) {
      const day = new Date(Date.UTC(z.y, z.m - 1, z.d + i));
      const cand = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(open / 60), open % 60, sla.timezone);
      if (cand > cursor && sla.business_days.includes(zonedParts(cand, sla.timezone).dow)) {
        next = cand;
        break;
      }
    }
    if (!Number.isFinite(next)) return startTs + minutes * 60000;
    cursor = next;
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatCountdown(ms: number): string {
  const abs = Math.abs(ms);
  const totalMin = Math.floor(abs / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return text;
}

// ---------------------------------------------------------------------------
// Coverage evaluation
// ---------------------------------------------------------------------------

export interface EngineContract {
  id: string;
  contract_name: string;
  status: string;
  customer_id: string | null;
  start_date: string | null;
  end_date: string | null;
  auto_renew: boolean;
  renewal_notice_days: number;
  billing_frequency: 'monthly' | 'quarterly' | 'annual' | 'one_time';
  contract_value_cents: number | null;
  sla_response_minutes_standard: number | null;
  sla_response_minutes_critical: number | null;
  sla_resolution_hours: number | null;
  penalty_percentage: number | null;
  penalty_cap_percentage: number | null;
}

export interface EngineProfile {
  terms: ContractTerms;
  review_status: 'draft' | 'verified';
}

export interface EngineJob {
  id: string;
  customer_id: string | null;
  service_type: string | null;
  /** Jobs have no is_emergency column — derive it from the linked call (calls.is_emergency). */
  is_emergency: boolean;
  tags: string[] | null;
  created_at: string;
  scheduled_datetime: string | null;
  job_status: string;
  invoice_amount: number | null;
  diagnosis_notes?: string | null;
}

export interface EngineEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  warranty_expires_at: string | null;
}

export interface Reason {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

export interface CoverageResult {
  job_id: string;
  contract_id: string;
  contract_name: string;
  verdict: Verdict;
  billing_action: BillingAction;
  headline: string;
  action_line: string;
  priority: Priority;
  terms_verified: boolean;
  has_terms: boolean;
  response: {
    status: ResponseStatus;
    target_minutes: number | null;
    started_at: string;
    deadline_at: string | null;
    met_at: string | null;
    /** ms until deadline (negative = overdue). Null once met or not applicable. */
    remaining_ms: number | null;
  };
  reasons: Reason[];
  flags: string[];
}

const LIVE = new Set(['active', 'expiring_soon']);
const RESPONDED = new Set(['en_route', 'in_progress', 'completed']);
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim();
const hit = (haystack: string, needle: string) => needle !== '' && haystack.includes(needle);

function jobPriority(job: EngineJob): Priority {
  const tags = (job.tags ?? []).map(norm);
  if (job.is_emergency || tags.includes('emergency')) return 'emergency';
  return tags.some((t) => t === 'urgent' || t === 'priority' || t === 'asap') ? 'urgent' : 'standard';
}

function pickContract(job: EngineJob, contracts: EngineContract[], at: number): { contract: EngineContract | null; multiple: boolean } {
  if (!job.customer_id) return { contract: null, multiple: false };
  const matches = contracts.filter((c) => {
    if (c.customer_id !== job.customer_id || !LIVE.has(c.status)) return false;
    const from = c.start_date ? new Date(c.start_date).getTime() : -Infinity;
    const to = c.end_date ? new Date(c.end_date).getTime() + 86_400_000 : Infinity;
    return at >= from && at < to;
  });
  matches.sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''));
  return { contract: matches[0] ?? null, multiple: matches.length > 1 };
}

export function computePenaltyCents(
  contract: EngineContract,
  terms: ContractTerms,
  invoiceAmount: number | null,
  minutesOver: number
): number {
  let type = terms.sla.penalty_type;
  let amount = terms.sla.penalty_amount;
  // Fall back to the flat columns already on commercial_contracts.
  if (type === 'none' && (contract.penalty_percentage ?? 0) > 0) {
    type = 'percent_of_invoice';
    amount = contract.penalty_percentage;
  }
  if (type === 'none' || amount === null || amount <= 0 || minutesOver <= 0) return 0;

  const intervals = terms.sla.penalty_interval_minutes ? Math.ceil(minutesOver / terms.sla.penalty_interval_minutes) : 1;
  let base = 0;
  if (type === 'flat_cents') base = amount;
  else if (type === 'percent_of_invoice') base = Math.round((invoiceAmount ?? 0) * 100 * (amount / 100));
  else {
    // contract_value_cents is read as the fee per billing period.
    const perMonthDivisor = { monthly: 1, quarterly: 3, annual: 12, one_time: 1 }[contract.billing_frequency] ?? 1;
    base = Math.round(((contract.contract_value_cents ?? 0) / perMonthDivisor) * (amount / 100));
  }
  let total = base * intervals;
  if (contract.contract_value_cents && contract.penalty_cap_percentage !== null && contract.penalty_cap_percentage >= 0) {
    total = Math.min(total, Math.round(contract.contract_value_cents * (contract.penalty_cap_percentage / 100)));
  }
  return Math.max(0, total);
}

/**
 * Evaluate one job against the account's contracts. Returns null when the job
 * has no live contract for its customer (nothing to say: bill as normal).
 */
export function evaluateJob(params: {
  job: EngineJob;
  contracts: EngineContract[];
  profiles: Map<string, EngineProfile>;
  equipment: EngineEquipment[];
  responseMetAt: string | null;
  now?: Date;
}): CoverageResult | null {
  const { job, contracts, profiles, equipment, responseMetAt } = params;
  const now = (params.now ?? new Date()).getTime();
  const jobAt = new Date(job.scheduled_datetime ?? job.created_at).getTime();
  const { contract, multiple } = pickContract(job, contracts, jobAt);
  if (!contract) return null;

  const profile = profiles.get(contract.id) ?? null;
  const terms = profile?.terms ?? emptyTerms();
  const verified = profile?.review_status === 'verified';
  const reasons: Reason[] = [];
  const flags: string[] = [];
  if (multiple) {
    flags.push('multiple_contracts');
    reasons.push({ tone: 'warn', text: 'More than one live contract matches this customer — using the most recent one.' });
  }

  // ---- Response clock ------------------------------------------------------
  const priority = jobPriority(job);
  const target =
    priority === 'emergency'
      ? terms.sla.response_emergency_minutes ?? contract.sla_response_minutes_critical
      : priority === 'urgent'
        ? terms.sla.response_urgent_minutes ?? contract.sla_response_minutes_standard
        : terms.sla.response_standard_minutes ?? contract.sla_response_minutes_standard;

  const startedTs = new Date(job.created_at).getTime();
  let responseStatus: ResponseStatus = 'not_applicable';
  let deadlineTs: number | null = null;
  let metTs: number | null = null;
  let remaining: number | null = null;

  if (target !== null && target !== undefined && !['cancelled', 'no_show'].includes(job.job_status)) {
    deadlineTs = addCoveredMinutes(startedTs, target, terms.sla);
    metTs = responseMetAt ? new Date(responseMetAt).getTime() : null;
    if (metTs !== null) responseStatus = metTs <= deadlineTs ? 'met' : 'breached';
    else if (RESPONDED.has(job.job_status)) responseStatus = 'met'; // responded, exact time not stamped
    else {
      responseStatus = now > deadlineTs ? 'breached' : 'pending';
      remaining = deadlineTs - now;
    }
  }
  if (responseStatus === 'breached') flags.push('sla_breached');
  else if (responseStatus === 'pending' && remaining !== null && remaining < 3_600_000) flags.push('sla_at_risk');

  // ---- Coverage & billing ---------------------------------------------------
  const svc = norm(job.service_type);
  const notes = norm(job.diagnosis_notes);
  const eqTypes = equipment.map((e) => norm(e.equipment_type));
  let excluded: string | null = null;
  let notCovered: string | null = null;
  let needsReview = false;

  if (!profile) {
    needsReview = true;
    reasons.push({ tone: 'warn', text: 'Contract terms have not been analysed yet — only the base SLA fields are used.' });
    flags.push('terms_missing');
  } else {
    for (const rule of terms.coverage.exclusions) {
      const v = norm(rule.value);
      const matched =
        rule.kind === 'service_type' ? hit(svc, v) : rule.kind === 'equipment_type' ? eqTypes.some((t) => hit(t, v)) : hit(svc, v) || hit(notes, v);
      if (matched) {
        excluded = `Excluded by contract: “${rule.value}”.`;
        break;
      }
    }
    if (!excluded && terms.coverage.service_types.length > 0) {
      if (svc === '') {
        needsReview = true;
        flags.push('no_service_type');
        reasons.push({ tone: 'warn', text: 'This job has no service type, so it cannot be matched to the covered services.' });
      } else if (!terms.coverage.service_types.some((s) => hit(svc, norm(s)) || hit(norm(s), svc))) {
        notCovered = `Service type “${job.service_type}” is not in the contract's covered services.`;
      }
    }
    if (!excluded && !notCovered && !terms.coverage.all_assets && terms.coverage.equipment_types.length > 0) {
      if (eqTypes.length === 0) {
        needsReview = true;
        reasons.push({ tone: 'warn', text: 'No equipment is linked to this job, so asset coverage cannot be confirmed.' });
        flags.push('no_equipment_linked');
      } else if (!eqTypes.some((t) => terms.coverage.equipment_types.some((c) => hit(t, norm(c)) || hit(norm(c), t)))) {
        notCovered = 'The equipment on this job is not a covered asset under the contract.';
      }
    }
  }

  let billing: BillingAction = 'bill_customer';
  let verdict: Verdict = 'not_covered';

  if (excluded || notCovered) {
    reasons.push({ tone: 'bad', text: (excluded ?? notCovered) as string });
  } else if (profile) {
    const { labor, parts } = terms.responsibility;
    let partsCovered: boolean | 'unknown' = parts === 'contractor';
    if (parts === 'warranty_only') {
      const underWarranty = equipment.some((e) => e.warranty_expires_at && new Date(e.warranty_expires_at).getTime() >= jobAt);
      partsCovered = equipment.length === 0 ? 'unknown' : underWarranty;
      if (partsCovered === 'unknown') needsReview = true;
    }
    if (labor === 'shared' || parts === 'shared') needsReview = true;
    const laborCovered = labor === 'contractor';

    if (laborCovered && partsCovered === true) {
      billing = 'do_not_bill';
      verdict = 'covered';
      reasons.push({ tone: 'ok', text: 'Labor and parts are the contractor’s responsibility under this contract.' });
    } else if (laborCovered) {
      billing = 'bill_parts_only';
      verdict = 'partially_covered';
      reasons.push({ tone: 'warn', text: 'Labor is covered; parts are billable to the customer.' });
    } else if (partsCovered === true) {
      billing = 'bill_labor_only';
      verdict = 'partially_covered';
      reasons.push({ tone: 'warn', text: 'Parts are covered; labor is billable to the customer.' });
    } else {
      reasons.push({ tone: 'bad', text: 'Neither labor nor parts are covered by this contract.' });
    }

    const cap = terms.responsibility.per_visit_cap_cents;
    if (cap !== null && job.invoice_amount !== null && job.invoice_amount * 100 > cap) {
      needsReview = true;
      flags.push('over_visit_cap');
      reasons.push({ tone: 'warn', text: `Invoice exceeds the per-visit cap of $${(cap / 100).toLocaleString('en-US')}.` });
    }
    if (!terms.coverage.after_hours_covered && terms.sla.clock === 'business' && !isWithinCoverage(startedTs, terms.sla)) {
      needsReview = true;
      flags.push('after_hours');
      reasons.push({ tone: 'warn', text: 'Requested outside covered hours — after-hours rates may apply.' });
    }
  }

  // Never recommend "Do not bill" off AI terms nobody has verified.
  if (profile && !verified && (billing === 'do_not_bill' || billing === 'bill_parts_only' || billing === 'bill_labor_only')) {
    flags.push('unverified_terms');
    reasons.push({ tone: 'warn', text: 'Contract terms are AI-extracted and not verified yet — confirm before changing what you bill.' });
    needsReview = true;
  }

  if (needsReview && !excluded && !notCovered) {
    verdict = 'needs_review';
    billing = 'review';
  }

  // ---- Contract health flags ----------------------------------------------
  if (contract.end_date) {
    const daysLeft = Math.round((new Date(contract.end_date).getTime() - now) / 86_400_000);
    if (daysLeft >= 0 && daysLeft <= contract.renewal_notice_days) {
      flags.push('renewal_window');
      reasons.push({ tone: 'warn', text: `Contract ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — inside the renewal notice window.` });
    }
  }
  const esc = terms.pricing.next_escalation_date;
  if (esc) {
    const days = Math.round((new Date(esc).getTime() - now) / 86_400_000);
    if (days >= 0 && days <= 60) {
      flags.push('escalation_due');
      const pct = terms.pricing.escalation_percent !== null ? ` (+${terms.pricing.escalation_percent}%)` : '';
      reasons.push({ tone: 'warn', text: `Price escalation${pct} takes effect in ${days} day${days === 1 ? '' : 's'}.` });
    }
  }
  if (terms.compliance.requirements.length > 0) {
    flags.push('compliance_required');
    reasons.push({ tone: 'warn', text: `Compliance required: ${terms.compliance.requirements.slice(0, 3).join('; ')}${terms.compliance.requirements.length > 3 ? '…' : ''}` });
  }
  if (responseStatus === 'breached') {
    reasons.push({ tone: 'bad', text: metTs !== null ? 'Response was later than the SLA deadline.' : 'SLA response deadline has passed without a response.' });
  }

  const headline =
    verdict === 'covered'
      ? 'This job is contract-covered.'
      : verdict === 'partially_covered'
        ? 'This job is partially contract-covered.'
        : verdict === 'needs_review'
          ? 'Contract found — review needed before billing.'
          : 'This job is not covered by the contract.';

  const actionLine =
    billing === 'do_not_bill'
      ? 'Do not bill customer — covered under SLA.'
      : billing === 'bill_parts_only'
        ? 'Bill parts only — labor is covered.'
        : billing === 'bill_labor_only'
          ? 'Bill labor only — parts are covered.'
          : billing === 'review'
            ? 'Hold invoice until the contract terms are confirmed.'
            : 'Bill the customer as normal.';

  return {
    job_id: job.id,
    contract_id: contract.id,
    contract_name: contract.contract_name,
    verdict,
    billing_action: billing,
    headline,
    action_line: actionLine,
    priority,
    terms_verified: verified,
    has_terms: !!profile,
    response: {
      status: responseStatus,
      target_minutes: target ?? null,
      started_at: new Date(startedTs).toISOString(),
      deadline_at: deadlineTs !== null ? new Date(deadlineTs).toISOString() : null,
      met_at: metTs !== null ? new Date(metTs).toISOString() : null,
      remaining_ms: remaining,
    },
    reasons,
    flags: [...new Set(flags)],
  };
}

/** Stable fingerprint of what gets persisted — lets the page skip no-op writes. */
export function coverageSignature(r: {
  contract_id: string;
  verdict: string;
  billing_action: string;
  priority: string;
  deadline_at: string | null;
  terms_verified: boolean;
  flags: string[];
  reasons: Reason[];
}): string {
  return JSON.stringify([r.contract_id, r.verdict, r.billing_action, r.priority, r.deadline_at ? new Date(r.deadline_at).toISOString() : null, r.terms_verified, [...r.flags].sort(), r.reasons.map((x) => x.text)]);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

export const VERDICT_LABELS: Record<Verdict, string> = {
  covered: 'Covered',
  partially_covered: 'Partially covered',
  not_covered: 'Not covered',
  needs_review: 'Needs review',
};

export const VERDICT_STYLES: Record<Verdict, string> = {
  covered: 'bg-success-500/10 text-success-500',
  partially_covered: 'bg-accent/10 text-accent',
  not_covered: 'bg-bg-tertiary text-text-secondary',
  needs_review: 'bg-warning-500/10 text-warning-500',
};

export const FLAG_LABELS: Record<string, string> = {
  sla_breached: 'SLA breached',
  sla_at_risk: 'SLA at risk',
  unverified_terms: 'Unverified terms',
  terms_missing: 'Terms not analysed',
  renewal_window: 'Renewal window',
  escalation_due: 'Price escalation due',
  compliance_required: 'Compliance required',
  over_visit_cap: 'Over visit cap',
  after_hours: 'After hours',
  no_equipment_linked: 'No equipment linked',
  no_service_type: 'No service type',
  multiple_contracts: 'Multiple contracts',
};

// Editor helpers: exclusions <-> one-per-line text.
export function exclusionsToText(rules: ExclusionRule[]): string {
  return rules.map((r) => (r.kind === 'keyword' ? r.value : `${r.kind}: ${r.value}`)).join('\n');
}

export function textToExclusions(text: string): ExclusionRule[] {
  const out: ExclusionRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(service_type|equipment_type|keyword)\s*:\s*(.+)$/i.exec(line);
    out.push(m ? { kind: m[1].toLowerCase() as ExclusionKind, value: m[2].trim() } : { kind: 'keyword', value: line });
  }
  return out.slice(0, 40);
}

export const splitLines = (text: string): string[] =>
  text.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 40);

export const splitCsv = (text: string): string[] =>
  text.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
