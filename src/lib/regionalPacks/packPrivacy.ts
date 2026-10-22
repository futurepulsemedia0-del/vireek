/* ------------------------------------------------------------------ */
/*  Privacy tooling: GDPR / UK GDPR / PIPEDA / Quebec Law 25 / CASL /  */
/*  Australia Privacy Act + Spam Act / CCPA / CAN-SPAM.                */
/*  Pure decision logic: deadlines, consent evaluation, erasure plans, */
/*  portability files. Persistence lives in regionalPacksApi.ts.       */
/*  This is tooling, not legal advice — see `notes` on each regime.    */
/* ------------------------------------------------------------------ */
import { addBusinessDays, addDays, addMonths, isValidIso, nextBusinessDay } from './packHolidays';
import { getCountry } from './packData';

export type RegimeId = 'GDPR' | 'UK_GDPR' | 'PIPEDA' | 'QC_LAW25' | 'CASL' | 'AU_PRIVACY' | 'AU_SPAM' | 'CCPA' | 'CAN_SPAM';
export type Right = 'access' | 'rectification' | 'erasure' | 'portability' | 'restriction' | 'objection';
export type RightLevel = 'full' | 'limited' | 'none';

export interface Regime {
  id: RegimeId;
  name: string;
  responseDays: number | null;
  responseMonths: number | null;
  extensionDays: number;
  rights: Record<Right, RightLevel>;
  notes: string[];
}

const rights = (o: Partial<Record<Right, RightLevel>>): Record<Right, RightLevel> => ({
  access: 'none', rectification: 'none', erasure: 'none', portability: 'none', restriction: 'none', objection: 'none', ...o,
});

export const REGIMES: Readonly<Record<RegimeId, Regime>> = {
  GDPR: {
    id: 'GDPR', name: 'EU GDPR', responseDays: null, responseMonths: 1, extensionDays: 60,
    rights: rights({ access: 'full', rectification: 'full', erasure: 'full', portability: 'full', restriction: 'full', objection: 'full' }),
    notes: ['One month to respond, extendable by two further months for complex or numerous requests.', 'Erasure does not override legal retention duties such as tax and accounting records.'],
  },
  UK_GDPR: {
    id: 'UK_GDPR', name: 'UK GDPR + PECR', responseDays: null, responseMonths: 1, extensionDays: 60,
    rights: rights({ access: 'full', rectification: 'full', erasure: 'full', portability: 'full', restriction: 'full', objection: 'full' }),
    notes: ['One month to respond, extendable by up to two months for complex requests.'],
  },
  PIPEDA: {
    id: 'PIPEDA', name: 'Canada PIPEDA', responseDays: 30, responseMonths: null, extensionDays: 30,
    rights: rights({ access: 'full', rectification: 'full', erasure: 'limited', objection: 'limited' }),
    notes: ['30 days to respond; a further 30-day extension is allowed in limited cases.', 'No general statutory erasure right — withdrawal of consent and accuracy duties apply.'],
  },
  QC_LAW25: {
    id: 'QC_LAW25', name: 'Quebec Law 25', responseDays: 30, responseMonths: null, extensionDays: 0,
    rights: rights({ access: 'full', rectification: 'full', erasure: 'limited', portability: 'full', objection: 'limited' }),
    notes: ['30 days to respond to access and rectification requests.', 'Includes portability in a structured, commonly used technological format.'],
  },
  CASL: {
    id: 'CASL', name: 'Canada CASL', responseDays: null, responseMonths: null, extensionDays: 0, rights: rights({}),
    notes: ['Commercial electronic messages need express or implied consent, sender identification and a working unsubscribe honoured within 10 business days.', 'The sender must be able to prove consent.'],
  },
  AU_PRIVACY: {
    id: 'AU_PRIVACY', name: 'Australia Privacy Act (APPs)', responseDays: 30, responseMonths: null, extensionDays: 0,
    rights: rights({ access: 'full', rectification: 'full', erasure: 'limited' }),
    notes: ['Respond to access and correction requests within 30 days.', 'No general erasure right; personal information must be destroyed or de-identified once no longer needed (APP 11).'],
  },
  AU_SPAM: {
    id: 'AU_SPAM', name: 'Australia Spam Act 2003', responseDays: null, responseMonths: null, extensionDays: 0, rights: rights({}),
    notes: ['Marketing messages need consent (express or inferred), sender identification and a functional unsubscribe honoured within 5 business days.'],
  },
  CCPA: {
    id: 'CCPA', name: 'California CCPA / CPRA', responseDays: 45, responseMonths: null, extensionDays: 45,
    rights: rights({ access: 'full', rectification: 'full', erasure: 'full', portability: 'full', objection: 'full' }),
    notes: ['45 days to respond, extendable once by 45 days with notice.', 'Other US states have their own privacy laws with different thresholds — check each state you serve.'],
  },
  CAN_SPAM: {
    id: 'CAN_SPAM', name: 'US CAN-SPAM (+ TCPA for texts)', responseDays: null, responseMonths: null, extensionDays: 0, rights: rights({}),
    notes: ['Email is opt-out: honour unsubscribes within 10 business days.', 'Marketing texts need prior express written consent (TCPA) — your SMS compliance gate stays authoritative.'],
  },
};

/** Regimes that apply to a customer/site in a country (and province/state when known). */
export function regimesFor(country: string, subdivision?: string | null): RegimeId[] {
  const c = getCountry(country);
  const sub = subdivision?.toUpperCase();
  if (!c) return [];
  switch (c.pack) {
    case 'EU': return ['GDPR'];
    case 'GB': return ['UK_GDPR'];
    case 'CA': return sub === 'QC' ? ['PIPEDA', 'QC_LAW25', 'CASL'] : ['PIPEDA', 'CASL'];
    case 'AU': return ['AU_PRIVACY', 'AU_SPAM'];
    case 'US': return sub === 'CA' ? ['CCPA', 'CAN_SPAM'] : ['CAN_SPAM'];
  }
}

export function marketingRegimeFor(country: string): RegimeId | null {
  const c = getCountry(country);
  if (!c) return null;
  return ({ EU: 'GDPR', GB: 'UK_GDPR', CA: 'CASL', AU: 'AU_SPAM', US: 'CAN_SPAM' } as const)[c.pack];
}

/* --------------------------- request deadlines ---------------------- */

export interface DeadlineInput {
  regime: RegimeId;
  /** ISO date the request was received (verified). */
  receivedOn: string;
  country: string;
  subdivision?: string | null;
  extended?: boolean;
}
export interface Deadline { dueOn: string; basis: string; extended: boolean }

export function computeRequestDeadline(i: DeadlineInput): Deadline {
  if (!isValidIso(i.receivedOn)) throw new Error('receivedOn must be an ISO date (YYYY-MM-DD).');
  const reg = REGIMES[i.regime];
  if (reg.responseDays == null && reg.responseMonths == null) throw new Error(`${reg.name} has no data-request deadline.`);
  const extended = !!i.extended && reg.extensionDays > 0;
  if (reg.responseMonths != null) {
    const months = reg.responseMonths + (extended ? Math.round(reg.extensionDays / 30) : 0);
    // A deadline that lands on a weekend/holiday rolls to the next working day.
    const due = nextBusinessDay(addMonths(i.receivedOn, months), i.country, i.subdivision);
    return { dueOn: due, basis: `${months} month${months > 1 ? 's' : ''}`, extended };
  }
  const days = (reg.responseDays as number) + (extended ? reg.extensionDays : 0);
  return { dueOn: addDays(i.receivedOn, days), basis: `${days} days`, extended };
}

export function daysUntil(dueOn: string, today: string): number {
  return Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Latest date an unsubscribe must be honoured. */
export function unsubscribeDeadline(regime: RegimeId, requestedOn: string, country: string, subdivision?: string | null): string {
  switch (regime) {
    case 'CASL': case 'CAN_SPAM': return addBusinessDays(requestedOn, 10, country, subdivision);
    case 'AU_SPAM': return addBusinessDays(requestedOn, 5, country, subdivision);
    default: return requestedOn; // GDPR/PECR: without undue delay
  }
}

/* ------------------------- marketing consent ------------------------ */

export interface ConsentEvidence {
  consent_type: string;
  granted: boolean;
  created_at: string;
  expires_at?: string | null;
}
export interface MarketingCheckInput {
  channel: 'email' | 'sms';
  regime: RegimeId;
  records: readonly ConsentEvidence[];
  lastPurchaseAt?: string | null;
  lastInquiryAt?: string | null;
  now?: Date;
  /** EU only: set true if your member state allows the "soft opt-in" for existing customers. Default false. */
  allowSoftOptIn?: boolean;
  /** Months an existing relationship counts as consent. CASL fixes this at 24. */
  relationshipMonths?: number;
}
export type ConsentBasis = 'express' | 'implied_relationship' | 'implied_inquiry' | 'soft_opt_in' | 'opt_out_regime' | 'withdrawn' | 'expired' | 'none';
export interface MarketingDecision { allowed: boolean; basis: ConsentBasis; expiresAt: string | null; reason: string; requirements: string[] }

const SENDER_RULES = ['Identify your business and include a mailing address.', 'Include a working unsubscribe in every message.'];

function requirementsFor(regime: RegimeId): string[] {
  switch (regime) {
    case 'CASL': return [...SENDER_RULES, 'Honour unsubscribes within 10 business days.', 'Keep proof of consent — the burden of proof is on you.'];
    case 'AU_SPAM': return [...SENDER_RULES, 'Honour unsubscribes within 5 business days.', 'Keep evidence of consent or the existing relationship.'];
    case 'CAN_SPAM': return [...SENDER_RULES, 'Honour unsubscribes within 10 business days.'];
    case 'UK_GDPR': return ['Offer an opt-out at collection and in every message.', 'Soft opt-in covers only similar products/services.', 'Record when and how consent or the relationship arose.'];
    default: return ['Record when and how consent was given.', 'Make withdrawing consent as easy as giving it.'];
  }
}

export function evaluateMarketingConsent(i: MarketingCheckInput): MarketingDecision {
  const now = i.now ?? new Date();
  const type = i.channel === 'email' ? 'marketing_email' : 'marketing_sms';
  const requirements = requirementsFor(i.regime);
  const out = (allowed: boolean, basis: ConsentBasis, reason: string, expiresAt: Date | null = null): MarketingDecision =>
    ({ allowed, basis, expiresAt: expiresAt ? expiresAt.toISOString() : null, reason, requirements });

  const latest = i.records
    .filter((r) => r.consent_type === type)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

  if (latest && !latest.granted) return out(false, 'withdrawn', 'The customer withdrew consent. Do not send marketing until they opt in again.');

  let expiredExpress = false;
  if (latest?.granted) {
    const exp = latest.expires_at ? new Date(latest.expires_at) : null;
    if (!exp || exp.getTime() > now.getTime()) return out(true, 'express', 'Express consent is on record.', exp);
    expiredExpress = true;
  }

  const within = (iso: string | null | undefined, months: number): Date | null => {
    if (!iso) return null;
    const start = new Date(iso);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(addMonths(start.toISOString().slice(0, 10), months) + 'T23:59:59Z');
    return end.getTime() >= now.getTime() ? end : null;
  };

  switch (i.regime) {
    case 'CASL': {
      const p = within(i.lastPurchaseAt, 24);
      if (p) return out(true, 'implied_relationship', 'Implied consent: purchase within the last 24 months.', p);
      const q = within(i.lastInquiryAt, 6);
      if (q) return out(true, 'implied_inquiry', 'Implied consent: inquiry within the last 6 months.', q);
      break;
    }
    case 'AU_SPAM': {
      const p = within(i.lastPurchaseAt, i.relationshipMonths ?? 24);
      if (p) return out(true, 'implied_relationship', 'Inferred consent from an existing customer relationship.', p);
      break;
    }
    case 'UK_GDPR': {
      const p = within(i.lastPurchaseAt, i.relationshipMonths ?? 24);
      if (p) return out(true, 'soft_opt_in', 'PECR soft opt-in: existing customer, similar services, opt-out offered.', p);
      break;
    }
    case 'GDPR': {
      if (i.allowSoftOptIn) {
        const p = within(i.lastPurchaseAt, i.relationshipMonths ?? 24);
        if (p) return out(true, 'soft_opt_in', 'Soft opt-in for existing customers (where your member state allows it).', p);
      }
      break;
    }
    case 'CAN_SPAM': {
      if (i.channel === 'email') return out(true, 'opt_out_regime', 'US email marketing is opt-out: allowed until the customer unsubscribes.');
      return out(false, 'none', 'Marketing texts need prior express written consent (TCPA). None is on record.');
    }
    default: break;
  }
  return out(false, expiredExpress ? 'expired' : 'none', expiredExpress ? 'Recorded consent has expired.' : 'No valid consent on record. Collect opt-in before sending.');
}

/* ----------------------------- erasure plan ------------------------- */

/** Indicative minimum retention (years) for invoices/tax records. Confirm with your accountant. */
export const RETENTION_YEARS: Readonly<Record<string, number>> = {
  US: 7, CA: 6, GB: 6, AU: 5, DE: 8, FR: 10, ES: 6, IT: 10, NL: 7, IE: 6, AT: 7, BE: 7, PT: 10, PL: 5, SE: 7, DK: 5, FI: 6,
};
export const DEFAULT_RETENTION_YEARS = 7;
export const retentionYears = (country: string) => RETENTION_YEARS[country.toUpperCase()] ?? DEFAULT_RETENTION_YEARS;

export interface ErasureFacts {
  country: string;
  subdivision?: string | null;
  hasInvoices: boolean;
  lastInvoiceOn?: string | null;
  legalHold?: boolean;
  openDispute?: boolean;
  today?: string;
}
export type ErasureAction = 'erase' | 'anonymize' | 'retain' | 'defer';
export interface ErasureItem { category: string; action: ErasureAction; reason: string; until?: string | null }
export interface ErasurePlan { regimes: RegimeId[]; erasureRight: RightLevel; items: ErasureItem[]; canCompleteNow: boolean; notes: string[] }

export function planErasure(f: ErasureFacts): ErasurePlan {
  const regimes = regimesFor(f.country, f.subdivision);
  const levels = regimes.map((r) => REGIMES[r].rights.erasure);
  const erasureRight: RightLevel = levels.includes('full') ? 'full' : levels.includes('limited') ? 'limited' : 'none';
  const items: ErasureItem[] = [];
  const notes: string[] = [];

  if (f.legalHold || f.openDispute) {
    const why = f.legalHold ? 'A legal hold is active.' : 'An open dispute or claim needs the records.';
    for (const category of ['Contact details', 'Call recordings & transcripts', 'Job notes & photos', 'Invoices & tax records', 'Consent ledger', 'Audit log']) {
      items.push({ category, action: 'defer', reason: why });
    }
    return { regimes, erasureRight, items, canCompleteNow: false, notes: ['Erasure is paused. Resume once the hold or dispute is resolved and tell the requester why it was deferred.'] };
  }

  const keepYears = retentionYears(f.country);
  const today = f.today ?? new Date().toISOString().slice(0, 10);
  const base = f.lastInvoiceOn && isValidIso(f.lastInvoiceOn) ? f.lastInvoiceOn : today;
  const keepUntil = addMonths(`${base.slice(0, 4)}-12-31`, keepYears * 12); // end of year + N years, the conservative reading

  items.push({ category: 'Marketing profile & communication preferences', action: 'erase', reason: 'No legal duty to keep it.' });
  items.push({ category: 'Opt-out suppression entry', action: 'retain', reason: 'Minimal record so the person is not contacted again.' });
  items.push({ category: 'Call recordings & transcripts', action: 'erase', reason: 'Not required for tax or accounting.' });
  items.push({ category: 'Job notes & photos', action: 'anonymize', reason: 'Keep the work history for warranty and safety; remove identity.' });
  if (f.hasInvoices) {
    items.push({ category: 'Invoices & tax records', action: 'retain', reason: `Legal retention duty (indicative ${keepYears} years).`, until: keepUntil });
    items.push({ category: 'Contact details', action: 'anonymize', reason: 'Identity on invoices is kept only inside the retained tax records.' });
  } else {
    items.push({ category: 'Contact details', action: 'erase', reason: 'No invoices — nothing requires keeping them.' });
  }
  items.push({ category: 'Consent ledger', action: 'retain', reason: 'Proof of lawful processing / defence of legal claims.' });
  items.push({ category: 'Audit log', action: 'retain', reason: 'Security and accountability records.' });

  if (erasureRight === 'limited') notes.push('These regimes do not give a general statutory erasure right; de-identify data that is no longer needed and explain what is retained.');
  if (erasureRight === 'none') notes.push('No statutory erasure right found for this location. Apply your retention policy and respond to the request anyway.');
  notes.push('Retention periods are indicative minimums. Confirm with your accountant before deleting financial records.');
  return { regimes, erasureRight, items, canCompleteNow: true, notes };
}

/* --------------------------- portability file ----------------------- */

export interface PortabilityPackage {
  schema: 'vireek.portability.v1';
  generated_at: string;
  subject: { customer_id: string };
  sections: Record<string, Record<string, unknown>[]>;
}

export function parsePortabilityPackage(raw: unknown): PortabilityPackage {
  const o = raw as Partial<PortabilityPackage> | null;
  if (!o || typeof o !== 'object' || o.schema !== 'vireek.portability.v1' || !o.sections || typeof o.sections !== 'object') {
    throw new Error('Unexpected export format.');
  }
  const sections: PortabilityPackage['sections'] = {};
  for (const [k, v] of Object.entries(o.sections)) sections[k] = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  return { schema: o.schema, generated_at: String(o.generated_at ?? ''), subject: { customer_id: String(o.subject?.customer_id ?? '') }, sections };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
  return [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
}

export function serializePortability(pkg: PortabilityPackage): { json: string; csv: Record<string, string> } {
  const csv: Record<string, string> = {};
  for (const [name, rows] of Object.entries(pkg.sections)) if (rows.length) csv[name] = rowsToCsv(rows);
  return { json: JSON.stringify(pkg, null, 2), csv };
}
