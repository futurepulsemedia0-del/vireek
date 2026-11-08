/**
 * Merge-field registry for Document Template Studio. Shared by the UI (field picker, preview) and the
 * `doc-studio` edge function (authoritative validation + generation). Pure; no I/O.
 *
 * Trust model: customer / job / organization values come ONLY from the account's own database rows.
 * Callers may override just the `document.*` group (deal terms entered at generation time), and every
 * override is type-checked here — a client can never spoof a customer or organization value.
 */
import type { FieldDef, FieldValue, Values } from './mergeEngine.ts';

export const FIELD_DEFS: readonly FieldDef[] = [
  { key: 'customer.name', label: 'Customer name', type: 'text', group: 'customer', sample: 'Jordan Rivera' },
  { key: 'customer.email', label: 'Customer email', type: 'text', group: 'customer', sample: 'jordan@example.com' },
  { key: 'customer.phone', label: 'Customer phone', type: 'text', group: 'customer', sample: '(555) 010-2030' },
  { key: 'customer.address', label: 'Customer address', type: 'text', group: 'customer', sample: '48 Oak Ave' },
  { key: 'customer.type', label: 'Customer type (residential / commercial)', type: 'text', group: 'customer', sample: 'residential' },
  { key: 'job.service_type', label: 'Service type', type: 'text', group: 'job', sample: 'AC replacement' },
  { key: 'job.address', label: 'Job address', type: 'text', group: 'job', sample: '48 Oak Ave' },
  { key: 'job.scheduled_date', label: 'Scheduled date', type: 'date', group: 'job', sample: '2026-06-09' },
  { key: 'organization.name', label: 'Business name', type: 'text', group: 'organization', sample: 'Summit Home Services' },
  { key: 'organization.phone', label: 'Business phone', type: 'text', group: 'organization', sample: '(555) 010-9000' },
  { key: 'organization.email', label: 'Business email', type: 'text', group: 'organization', sample: 'office@example.com' },
  { key: 'document.generated_date', label: 'Generated date', type: 'date', group: 'document', sample: '2026-06-01' },
  { key: 'document.effective_date', label: 'Effective date', type: 'date', group: 'document', sample: '2026-06-15' },
  { key: 'document.reference', label: 'Reference', type: 'text', group: 'document', sample: 'AGR-1042' },
  { key: 'document.total', label: 'Total amount', type: 'money_cents', group: 'document', sample: '4,850.00' },
  { key: 'document.deposit', label: 'Deposit amount', type: 'money_cents', group: 'document', sample: '1,000.00' },
  { key: 'document.requires_deposit', label: 'Requires deposit (yes/no)', type: 'bool', group: 'document', sample: 'true' },
  { key: 'document.notes', label: 'Notes', type: 'text', group: 'document', sample: 'Gate code 4411' },
];

/** Keys a caller may supply at generation time. generated_date is always set by the server. */
export const OVERRIDABLE_KEYS: ReadonlySet<string> = new Set(
  FIELD_DEFS.filter((f) => f.group === 'document' && f.key !== 'document.generated_date').map((f) => f.key),
);

export interface CustomerFacts { name?: string | null; email?: string | null; phone?: string | null; address?: string | null; customer_type?: string | null }
export interface JobFacts { service_type?: string | null; address?: string | null; scheduled_datetime?: string | null }
export interface OrganizationFacts { company_name?: string | null; phone?: string | null; email?: string | null }

export interface ResolveInput {
  customer?: CustomerFacts | null;
  job?: JobFacts | null;
  organization?: OrganizationFacts | null;
  overrides?: Readonly<Record<string, unknown>> | null;
  now?: Date;
}

export interface ResolveResult { values: Values; rejected: { key: string; reason: string }[] }

const MAX_TEXT = 2_000;
const MAX_MINOR = 1_000_000_000_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v: string | null | undefined): FieldValue => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, MAX_TEXT);
  return t === '' ? undefined : t;
};

function checkOverride(def: FieldDef, raw: unknown): { ok: true; value: FieldValue } | { ok: false; reason: string } {
  if (def.type === 'text') {
    return typeof raw === 'string' ? { ok: true, value: clean(raw) } : { ok: false, reason: 'expected text' };
  }
  if (def.type === 'bool') {
    return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, reason: 'expected yes/no' };
  }
  if (def.type === 'money_cents') {
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_MINOR
      ? { ok: true, value: raw }
      : { ok: false, reason: 'expected a non-negative integer amount in minor units' };
  }
  if (typeof raw === 'string' && DATE_ONLY.test(raw.trim())) {
    const t = raw.trim();
    const d = new Date(`${t}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t) return { ok: true, value: t };
  }
  return { ok: false, reason: 'expected a valid YYYY-MM-DD date' };
}

export function resolveValues(input: ResolveInput): ResolveResult {
  const v: Record<string, FieldValue> = {};
  const c = input.customer;
  const j = input.job;
  const o = input.organization;
  if (c) {
    v['customer.name'] = clean(c.name);
    v['customer.email'] = clean(c.email);
    v['customer.phone'] = clean(c.phone);
    v['customer.address'] = clean(c.address);
    v['customer.type'] = clean(c.customer_type);
  }
  if (j) {
    v['job.service_type'] = clean(j.service_type);
    v['job.address'] = clean(j.address);
    v['job.scheduled_date'] = clean(j.scheduled_datetime);
  }
  if (o) {
    v['organization.name'] = clean(o.company_name);
    v['organization.phone'] = clean(o.phone);
    v['organization.email'] = clean(o.email);
  }
  v['document.generated_date'] = (input.now ?? new Date()).toISOString().slice(0, 10);

  const rejected: { key: string; reason: string }[] = [];
  const defs = new Map(FIELD_DEFS.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(input.overrides ?? {})) {
    const def = defs.get(key);
    if (!def || !OVERRIDABLE_KEYS.has(key)) { rejected.push({ key, reason: 'not an overridable field' }); continue; }
    const r = checkOverride(def, raw);
    if (r.ok) v[key] = r.value;
    else rejected.push({ key, reason: r.reason });
  }
  for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
  return { values: v, rejected };
}
