/**
 * Commercial pack — net terms + consolidated (statement) invoicing (PURE, integer cents only).
 * Tax is carried per source invoice and summed, so a statement never disagrees with its invoices by a rounding cent.
 */

export type NetTerms = { kind: 'due_on_receipt' } | { kind: 'net'; days: number } | { kind: 'net_eom'; days: number };
export type Cadence = 'per_invoice' | 'weekly' | 'monthly';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NET_DAYS = 180;

function parse(d: string): Date {
  const date = new Date(`${d}T00:00:00Z`);
  // Round-trip check: V8 silently rolls "2027-02-30" over to March 2.
  if (!DATE_RE.test(d) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== d) throw new RangeError(`Invalid date "${d}"`);
  return date;
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (d: Date, n: number) => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; };

export function validateTerms(t: NetTerms): string[] {
  if (t.kind === 'due_on_receipt') return [];
  return Number.isInteger(t.days) && t.days >= 0 && t.days <= MAX_NET_DAYS ? [] : [`Days must be a whole number from 0 to ${MAX_NET_DAYS}`];
}

/** Due date for an invoice issued on `issuedOn` (YYYY-MM-DD). */
export function dueDate(issuedOn: string, terms: NetTerms): string {
  const errors = validateTerms(terms);
  if (errors.length) throw new RangeError(errors[0]);
  const issued = parse(issuedOn);
  if (terms.kind === 'due_on_receipt') return fmt(issued);
  if (terms.kind === 'net') return fmt(plusDays(issued, terms.days));
  const eom = new Date(Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth() + 1, 0));
  return fmt(plusDays(eom, terms.days));
}

export interface BillableItem {
  id: string;
  customerId: string;
  siteId?: string | null;
  poNumber?: string | null;
  /** Date the work was invoiced / completed (YYYY-MM-DD). */
  issuedOn: string;
  subtotalCents: number;
  taxCents: number;
}

export interface ConsolidationOptions {
  cadence: Cadence;
  /** Keep each PO on its own statement (most commercial AP departments require this). */
  splitByPo?: boolean;
  splitBySite?: boolean;
  terms: NetTerms;
}

export interface Statement {
  /** Deterministic key: re-running consolidation for the same inputs yields the same key (idempotency anchor). */
  key: string;
  customerId: string;
  siteId: string | null;
  poNumber: string | null;
  periodStart: string;
  periodEnd: string;
  itemIds: string[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  issueOn: string;
  dueOn: string;
}

function period(issuedOn: string, cadence: Cadence): { start: string; end: string } {
  const d = parse(issuedOn);
  if (cadence === 'per_invoice') return { start: issuedOn, end: issuedOn };
  if (cadence === 'monthly') {
    return { start: fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))), end: fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))) };
  }
  const monday = plusDays(d, -((d.getUTCDay() + 6) % 7));
  return { start: fmt(monday), end: fmt(plusDays(monday, 6)) };
}

export function consolidate(items: BillableItem[], opts: ConsolidationOptions): Statement[] {
  const seen = new Set<string>();
  const groups = new Map<string, Statement>();
  for (const it of items) {
    if (seen.has(it.id)) continue; // duplicate input row: counted once
    seen.add(it.id);
    if (!Number.isInteger(it.subtotalCents) || !Number.isInteger(it.taxCents) || it.taxCents < 0) throw new RangeError(`Item ${it.id}: amounts must be whole cents`);
    const p = period(it.issuedOn, opts.cadence);
    const po = opts.splitByPo ? (it.poNumber?.trim() || null) : null;
    const site = opts.splitBySite ? it.siteId ?? null : null;
    // per_invoice statements are keyed by the invoice itself so two same-day invoices stay separate.
    const key = [it.customerId, opts.cadence === 'per_invoice' ? it.id : p.start, po ?? '-', site ?? '-'].join('|');
    let g = groups.get(key);
    if (!g) {
      g = {
        key, customerId: it.customerId, siteId: site, poNumber: po, periodStart: p.start, periodEnd: p.end, itemIds: [],
        subtotalCents: 0, taxCents: 0, totalCents: 0, issueOn: p.end, dueOn: dueDate(p.end, opts.terms),
      };
      groups.set(key, g);
    }
    g.itemIds.push(it.id);
    g.subtotalCents += it.subtotalCents;
    g.taxCents += it.taxCents;
    g.totalCents = g.subtotalCents + g.taxCents;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, itemIds: [...g.itemIds].sort() }))
    .sort((a, b) => a.customerId.localeCompare(b.customerId) || a.periodStart.localeCompare(b.periodStart) || (a.poNumber ?? '').localeCompare(b.poNumber ?? '') || (a.siteId ?? '').localeCompare(b.siteId ?? '') || a.key.localeCompare(b.key));
}
