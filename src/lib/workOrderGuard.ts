// src/lib/workOrderGuard.ts
//
// Work-Order Guard — pure rule checker + Quarter Audit. No I/O, no AI: every flag carries a
// plain-English reason a human can verify against the portal's guidelines.
//
// Money is ALWAYS integer cents. Timestamps are ISO strings (UTC instants).
// "Days" rules (10-day invoice, 90-day eligibility) are counted in WHOLE LOCAL CALENDAR DAYS in
// the profile's timezone: completed 2026-07-01 with a 10-day rule is on time through 2026-07-11.
//
// IMPORTANT: SERVICECHANNEL_DEFAULTS below are starting values taken from the Jan 2025 Trade
// Partner Guidelines as supplied by the product owner. They are NOT enforced anywhere — every value
// is stored per portal profile and editable. Verify them against your current portal guidelines.

export type Outcome = 'open' | 'approved' | 'paid' | 'rejected' | 'voided' | 'expired' | 'cancelled';
export type ProposalStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type BreakdownKey = 'labor' | 'technicians' | 'materials' | 'trip' | 'freight';

export const OUTCOMES: Outcome[] = ['open', 'approved', 'paid', 'rejected', 'voided', 'expired', 'cancelled'];
export const BREAKDOWN_KEYS: BreakdownKey[] = ['labor', 'technicians', 'materials', 'trip', 'freight'];
/** Outcomes where the money did not arrive. */
export const LOST_OUTCOMES: Outcome[] = ['rejected', 'voided', 'expired'];

export interface PortalRules {
  acceptWindowMinutes: number;
  acceptWindowEmergencyMinutes: number;
  /** Lower-case priority labels treated as emergency (15-minute window by default). */
  emergencyPriorities: string[];
  /** Warn this many minutes before an accept window closes. */
  acceptWarnMinutes: number;
  checkInRadiusMiles: number;
  /** When a proposal exists, check-in must come after the proposal was approved. */
  checkInAfterProposalApproval: boolean;
  invoiceWithinDays: number;
  oneInvoicePerWorkOrder: boolean;
  ineligibleAfterDays: number;
  /** Warn this many days before a day-based deadline. */
  deadlineWarnDays: number;
  invoiceMayNotExceedNte: boolean;
  requiredBreakdown: BreakdownKey[];
  /** Allowed gap (cents) between the invoice total and the sum of its parts. */
  breakdownToleranceCents: number;
  allowSalesTax: boolean;
  allowManagementFee: boolean;
  /** Expected days from approval to deposit. Only used to rank deposit matches. */
  paymentTermsDays: number;
}

export const SERVICECHANNEL_DEFAULTS: PortalRules = {
  acceptWindowMinutes: 30,
  acceptWindowEmergencyMinutes: 15,
  emergencyPriorities: ['emergency'],
  acceptWarnMinutes: 10,
  checkInRadiusMiles: 0.25,
  checkInAfterProposalApproval: true,
  invoiceWithinDays: 10,
  oneInvoicePerWorkOrder: true,
  ineligibleAfterDays: 90,
  deadlineWarnDays: 3,
  invoiceMayNotExceedNte: true,
  requiredBreakdown: ['labor', 'technicians', 'materials', 'trip', 'freight'],
  breakdownToleranceCents: 0,
  allowSalesTax: false,
  allowManagementFee: false,
  paymentTermsDays: 30,
};

export const DEFAULT_TIMEZONE = 'America/New_York';

export interface WorkOrder {
  id?: string;
  woNumber: string;
  location: string | null;
  trade: string | null;
  priority: string;
  nteCents: number | null;
  estimateCents: number | null;
  receivedAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  checkedInAt: string | null;
  checkInDistanceMiles: number | null;
  proposalStatus: ProposalStatus;
  proposalAmountCents: number | null;
  proposalApprovedAt: string | null;
  completedAt: string | null;
  invoiceNumber: string | null;
  invoiceSubmittedAt: string | null;
  invoiceCount: number;
  invoiceLaborCents: number | null;
  invoiceTechnicians: number | null;
  invoiceMaterialsCents: number | null;
  invoiceTripCents: number | null;
  invoiceFreightCents: number | null;
  invoiceTaxCents: number | null;
  invoiceMgmtFeeCents: number | null;
  invoiceTotalCents: number | null;
  outcome: Outcome;
  outcomeReason: string | null;
}

export type FlagCode =
  | 'accept_expiring' | 'accept_late' | 'accept_missed'
  | 'over_nte'
  | 'checkin_out_of_range' | 'checkin_before_proposal'
  | 'invoice_due_soon' | 'invoice_late' | 'invoice_overdue' | 'duplicate_invoice'
  | 'wo_expiring_90d' | 'invoice_after_90d' | 'wo_ineligible'
  | 'sales_tax' | 'management_fee' | 'breakdown_missing' | 'breakdown_mismatch';

export interface Flag {
  code: FlagCode;
  /** violation = a rule is already broken (or the invoice would be rejected as it stands); warning = deadline approaching. */
  level: 'violation' | 'warning';
  title: string;
  detail: string;
  /** ISO instant or YYYY-MM-DD the rule's deadline falls on, when applicable. */
  deadline: string | null;
  /** Only for over_nte: dollars above the cap. */
  excessCents: number;
}

/** Violations that mean the order was handled too slowly (used to classify "late" audit items). */
export const TIMING_CODES: FlagCode[] = [
  'accept_late', 'accept_missed', 'invoice_late', 'invoice_overdue', 'invoice_after_90d', 'wo_ineligible',
];

export interface EvalContext {
  rules: PortalRules;
  timezone: string;
  now: Date;
}

// ------------------------------------------------------------------ helpers

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export const formatUsd = (cents: number): string =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const safeTz = (tz: string) => (isValidTimezone(tz) ? tz : 'UTC');

/** YYYY-MM-DD of an instant in `tz`. */
export function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: safeTz(tz), year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso));
}

/** Whole local calendar days from `fromIso` to `toIso` (negative if `toIso` is earlier). */
export function dayDiff(fromIso: string, toIso: string, tz: string): number {
  const a = Date.parse(`${localDate(fromIso, tz)}T00:00:00Z`);
  const b = Date.parse(`${localDate(toIso, tz)}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const fmtMinutes = (ms: number): string => {
  const m = Math.round(ms / MIN_MS);
  return m === 1 ? '1 minute' : `${m} minutes`;
};

export function hasInvoice(o: WorkOrder): boolean {
  return Boolean(
    o.invoiceNumber || o.invoiceSubmittedAt || o.invoiceTotalCents != null || o.invoiceLaborCents != null
    || o.invoiceMaterialsCents != null || o.invoiceTripCents != null || o.invoiceFreightCents != null,
  );
}

/** Money the order represents: invoice total, else the working estimate, else 0 (NTE is a cap, not a value). */
export function stakeCents(o: WorkOrder): number {
  return o.invoiceTotalCents ?? o.estimateCents ?? 0;
}

// ------------------------------------------------------------------ rules validation

/** Merge saved/partial JSON over the defaults so older profiles pick up newly added rules. */
export function mergeRules(partial: unknown): PortalRules {
  const src = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...SERVICECHANNEL_DEFAULTS };
  for (const key of Object.keys(SERVICECHANNEL_DEFAULTS)) {
    const dv = (SERVICECHANNEL_DEFAULTS as unknown as Record<string, unknown>)[key];
    const v = src[key];
    if (typeof dv === 'number' && typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof dv === 'boolean' && typeof v === 'boolean') out[key] = v;
    else if (Array.isArray(dv) && Array.isArray(v)) out[key] = v.filter((x) => typeof x === 'string');
  }
  const rules = out as unknown as PortalRules;
  rules.emergencyPriorities = rules.emergencyPriorities.map((p) => p.trim().toLowerCase()).filter(Boolean);
  rules.requiredBreakdown = BREAKDOWN_KEYS.filter((k) => (rules.requiredBreakdown as string[]).includes(k));
  return rules;
}

/** Human-readable problems; empty array = valid. The UI blocks saving while this is non-empty. */
export function validateRules(r: PortalRules): string[] {
  const errs: string[] = [];
  const int = (v: number) => Number.isInteger(v);
  if (!(r.acceptWindowMinutes >= 1 && r.acceptWindowMinutes <= 10_080 && int(r.acceptWindowMinutes))) errs.push('Accept window must be a whole number of minutes between 1 and 10080.');
  if (!(r.acceptWindowEmergencyMinutes >= 1 && r.acceptWindowEmergencyMinutes <= 10_080 && int(r.acceptWindowEmergencyMinutes))) errs.push('Emergency accept window must be a whole number of minutes between 1 and 10080.');
  if (!(r.acceptWarnMinutes >= 0 && r.acceptWarnMinutes <= 1_440 && int(r.acceptWarnMinutes))) errs.push('Accept warning must be 0–1440 whole minutes.');
  if (!(r.checkInRadiusMiles > 0 && r.checkInRadiusMiles <= 100)) errs.push('Check-in radius must be above 0 and at most 100 miles.');
  if (!(r.invoiceWithinDays >= 1 && r.invoiceWithinDays <= 365 && int(r.invoiceWithinDays))) errs.push('Invoice deadline must be 1–365 whole days.');
  if (!(r.ineligibleAfterDays >= 1 && r.ineligibleAfterDays <= 730 && int(r.ineligibleAfterDays))) errs.push('Eligibility limit must be 1–730 whole days.');
  if (!(r.deadlineWarnDays >= 0 && r.deadlineWarnDays <= 60 && int(r.deadlineWarnDays))) errs.push('Deadline warning must be 0–60 whole days.');
  if (!(r.breakdownToleranceCents >= 0 && r.breakdownToleranceCents <= 100_000 && int(r.breakdownToleranceCents))) errs.push('Breakdown tolerance must be 0–100000 cents.');
  if (!(r.paymentTermsDays >= 0 && r.paymentTermsDays <= 365 && int(r.paymentTermsDays))) errs.push('Payment terms must be 0–365 whole days.');
  if (r.emergencyPriorities.length > 20) errs.push('At most 20 emergency priority labels.');
  return errs;
}

// ------------------------------------------------------------------ rule checker

const mk = (code: FlagCode, level: Flag['level'], title: string, detail: string, deadline: string | null = null, excessCents = 0): Flag =>
  ({ code, level, title, detail, deadline, excessCents });

const ORDER: FlagCode[] = [
  'accept_missed', 'accept_late', 'accept_expiring', 'over_nte', 'checkin_out_of_range', 'checkin_before_proposal',
  'sales_tax', 'management_fee', 'breakdown_missing', 'breakdown_mismatch', 'duplicate_invoice',
  'invoice_overdue', 'invoice_late', 'invoice_due_soon', 'wo_ineligible', 'invoice_after_90d', 'wo_expiring_90d',
];

/** Flags one work order against a rule set as of `ctx.now`. Cancelled orders and clean orders return []. */
export function evaluateOrder(o: WorkOrder, ctx: EvalContext): Flag[] {
  if (o.outcome === 'cancelled') return [];
  const r = ctx.rules;
  const tz = safeTz(ctx.timezone);
  const now = ctx.now.getTime();
  const nowIso = ctx.now.toISOString();
  const flags: Flag[] = [];
  const invoiced = hasInvoice(o);
  const worked = Boolean(o.checkedInAt || o.completedAt || invoiced);
  const pending: Outcome[] = ['open', 'voided', 'expired'];

  // R1 — accept / decline window
  const received = Date.parse(o.receivedAt);
  const emergency = r.emergencyPriorities.includes(o.priority.trim().toLowerCase());
  const windowMs = (emergency ? r.acceptWindowEmergencyMinutes : r.acceptWindowMinutes) * MIN_MS;
  const acceptDeadline = received + windowMs;
  const acceptDeadlineIso = new Date(acceptDeadline).toISOString();
  const responded = o.acceptedAt ?? o.declinedAt;
  const kind = emergency ? 'emergency ' : '';
  if (responded) {
    const lateBy = Date.parse(responded) - acceptDeadline;
    if (lateBy > 0) {
      flags.push(mk('accept_late', 'violation', 'Accepted after the window closed',
        `${o.acceptedAt ? 'Accepted' : 'Declined'} ${fmtMinutes(lateBy)} after the ${fmtMinutes(windowMs)} ${kind}window.`, acceptDeadlineIso));
    }
  } else if (!worked && ['open', 'expired', 'voided', 'rejected'].includes(o.outcome)) {
    if (now > acceptDeadline) {
      flags.push(mk('accept_missed', 'violation', 'Accept window missed',
        `No accept/decline within the ${fmtMinutes(windowMs)} ${kind}window.`, acceptDeadlineIso));
    } else if (acceptDeadline - now <= r.acceptWarnMinutes * MIN_MS) {
      flags.push(mk('accept_expiring', 'warning', 'Accept window expiring',
        `${fmtMinutes(acceptDeadline - now)} left to accept or decline (${kind}window ${fmtMinutes(windowMs)}).`, acceptDeadlineIso));
    }
  }
  if (o.declinedAt && !o.acceptedAt) return sortFlags(flags);

  // R2 — amount vs NTE (an approved proposal raises the cap)
  const basis = o.invoiceTotalCents ?? o.estimateCents;
  if (r.invoiceMayNotExceedNte && o.nteCents != null && basis != null) {
    const approved = o.proposalStatus === 'approved';
    const cap = approved ? Math.max(o.nteCents, o.proposalAmountCents ?? 0) : o.nteCents;
    if (basis > cap) {
      const why = approved ? 'the approved proposal does not cover it' : o.proposalStatus === 'none' ? 'no proposal was approved' : `the proposal is ${o.proposalStatus}`;
      flags.push(mk('over_nte', 'violation', 'Over NTE without approved proposal',
        `${o.invoiceTotalCents != null ? 'Invoice' : 'Estimate'} ${formatUsd(basis)} exceeds the ${formatUsd(cap)} cap; ${why}.`, null, basis - cap));
    }
  }

  // R3 — check-in distance and ordering vs proposal approval
  if (o.checkedInAt) {
    if (o.checkInDistanceMiles != null && o.checkInDistanceMiles > r.checkInRadiusMiles) {
      flags.push(mk('checkin_out_of_range', 'violation', 'Check-in outside the allowed radius',
        `Checked in ${o.checkInDistanceMiles} mi from site; limit is ${r.checkInRadiusMiles} mi.`));
    }
    if (r.checkInAfterProposalApproval && o.proposalStatus !== 'none') {
      const early = o.proposalStatus === 'pending' || o.proposalStatus === 'rejected'
        || (o.proposalStatus === 'approved' && o.proposalApprovedAt != null && Date.parse(o.checkedInAt) < Date.parse(o.proposalApprovedAt));
      if (early) {
        flags.push(mk('checkin_before_proposal', 'violation', 'Checked in before proposal approval',
          o.proposalStatus === 'approved' ? 'Check-in happened before the proposal was approved.' : `Checked in while the proposal is ${o.proposalStatus}.`));
      }
    }
  }

  // R4 — invoice within N days of completion
  if (o.completedAt) {
    const dueDate = addDays(localDate(o.completedAt, tz), r.invoiceWithinDays);
    if (o.invoiceSubmittedAt) {
      const gap = dayDiff(o.completedAt, o.invoiceSubmittedAt, tz);
      if (gap > r.invoiceWithinDays) {
        flags.push(mk('invoice_late', 'violation', 'Invoice submitted late',
          `Invoiced ${gap} days after completion; limit is ${r.invoiceWithinDays}.`, dueDate));
      }
    } else if (pending.includes(o.outcome)) {
      const gap = dayDiff(o.completedAt, nowIso, tz);
      const left = r.invoiceWithinDays - gap;
      if (gap > r.invoiceWithinDays) {
        flags.push(mk('invoice_overdue', 'violation', 'Invoice overdue',
          `Completed ${gap} days ago and not invoiced; limit is ${r.invoiceWithinDays}.`, dueDate));
      } else if (left <= r.deadlineWarnDays && o.outcome === 'open') {
        flags.push(mk('invoice_due_soon', 'warning', 'Invoice due soon',
          left === 0 ? `Invoice is due today (${dueDate}).` : `${left} day${left === 1 ? '' : 's'} left to invoice (due ${dueDate}).`, dueDate));
      }
    }
  }

  // R5 — one invoice per work order
  if (r.oneInvoicePerWorkOrder && o.invoiceCount > 1) {
    flags.push(mk('duplicate_invoice', 'violation', 'More than one invoice on this work order',
      `${o.invoiceCount} invoices were submitted; the portal accepts one per work order.`));
  }

  // R6 — work order eligibility window
  const eligibleThrough = addDays(localDate(o.receivedAt, tz), r.ineligibleAfterDays);
  if (o.invoiceSubmittedAt) {
    const gap = dayDiff(o.receivedAt, o.invoiceSubmittedAt, tz);
    if (gap > r.ineligibleAfterDays) {
      flags.push(mk('invoice_after_90d', 'violation', 'Invoiced after the eligibility window',
        `Invoiced ${gap} days after the work order was received; limit is ${r.ineligibleAfterDays}.`, eligibleThrough));
    }
  } else if (pending.includes(o.outcome)) {
    const gap = dayDiff(o.receivedAt, nowIso, tz);
    const left = r.ineligibleAfterDays - gap;
    if (gap > r.ineligibleAfterDays) {
      flags.push(mk('wo_ineligible', 'violation', 'Work order no longer eligible',
        `Received ${gap} days ago and never invoiced; limit is ${r.ineligibleAfterDays}.`, eligibleThrough));
    } else if (left <= r.deadlineWarnDays && o.outcome === 'open') {
      flags.push(mk('wo_expiring_90d', 'warning', 'Work order about to become ineligible',
        left === 0 ? `Last eligible day is today (${eligibleThrough}).` : `${left} day${left === 1 ? '' : 's'} until ineligible (${eligibleThrough}).`, eligibleThrough));
    }
  }

  // R7 — invoice content the portal would reject
  if (invoiced) {
    if (!r.allowSalesTax && (o.invoiceTaxCents ?? 0) > 0) {
      flags.push(mk('sales_tax', 'violation', 'Sales tax on invoice', `Invoice includes ${formatUsd(o.invoiceTaxCents ?? 0)} of sales tax; this portal does not allow it.`));
    }
    if (!r.allowManagementFee && (o.invoiceMgmtFeeCents ?? 0) > 0) {
      flags.push(mk('management_fee', 'violation', 'Management fee line', `Invoice includes a ${formatUsd(o.invoiceMgmtFeeCents ?? 0)} management fee; this portal does not allow it.`));
    }
    const missing = r.requiredBreakdown.filter((k) => {
      if (k === 'technicians') return (o.invoiceLaborCents ?? 0) > 0 && !((o.invoiceTechnicians ?? 0) >= 1);
      const v = { labor: o.invoiceLaborCents, materials: o.invoiceMaterialsCents, trip: o.invoiceTripCents, freight: o.invoiceFreightCents }[k];
      return v == null;
    });
    if (missing.length > 0) {
      flags.push(mk('breakdown_missing', 'violation', 'Invoice breakout incomplete', `Missing: ${missing.join(', ')}. Enter 0 for categories that do not apply.`));
    }
    const parts = [o.invoiceLaborCents, o.invoiceMaterialsCents, o.invoiceTripCents, o.invoiceFreightCents, o.invoiceTaxCents, o.invoiceMgmtFeeCents];
    if (o.invoiceTotalCents != null && parts.some((p) => p != null)) {
      const sum = parts.reduce<number>((s, p) => s + (p ?? 0), 0);
      if (Math.abs(o.invoiceTotalCents - sum) > r.breakdownToleranceCents) {
        flags.push(mk('breakdown_mismatch', 'violation', 'Breakout does not add up to the total',
          `Parts add up to ${formatUsd(sum)} but the invoice total is ${formatUsd(o.invoiceTotalCents)}.`));
      }
    }
  }
  return sortFlags(flags);
}

function sortFlags(flags: Flag[]): Flag[] {
  const rank = (f: Flag) => (f.level === 'violation' ? 0 : 1) * 100 + ORDER.indexOf(f.code);
  return [...flags].sort((a, b) => rank(a) - rank(b));
}

// ------------------------------------------------------------------ Quarter Audit

export interface AuditItem {
  order: WorkOrder;
  /** Violations only (warnings are not part of a historical audit). */
  flags: Flag[];
  /** lost = voided / rejected / expired; late = still alive or paid, but a timing rule was broken. */
  category: 'lost' | 'late';
  stakeCents: number;
  /** True when at least one rule in the profile was broken, i.e. the contractor could have prevented it. */
  avoidable: boolean;
}

export interface AuditTotals {
  ordersReviewed: number;
  lostCount: number;
  lateCount: number;
  lostCents: number;
  lateCents: number;
  /** lost + late */
  atRiskCents: number;
  avoidableCount: number;
  avoidableCents: number;
  unavoidableCount: number;
  unavoidableCents: number;
  /** Items with no amount on file (counted at $0). */
  noAmountCount: number;
}

export interface AuditResult {
  items: AuditItem[];
  totals: AuditTotals;
  byRule: { code: FlagCode; count: number; cents: number }[];
}

export interface AuditOptions {
  rules: PortalRules;
  timezone: string;
  asOf: Date;
  /** Inclusive local dates (YYYY-MM-DD) of the received date. */
  from?: string;
  to?: string;
}

export function runAudit(orders: WorkOrder[], opts: AuditOptions): AuditResult {
  const tz = safeTz(opts.timezone);
  const inRange = (o: WorkOrder) => {
    const d = localDate(o.receivedAt, tz);
    return (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to);
  };
  const scoped = orders.filter((o) => o.outcome !== 'cancelled' && inRange(o));
  const items: AuditItem[] = [];
  for (const order of scoped) {
    const flags = evaluateOrder(order, { rules: opts.rules, timezone: tz, now: opts.asOf }).filter((f) => f.level === 'violation');
    const lost = LOST_OUTCOMES.includes(order.outcome);
    const late = !lost && flags.some((f) => TIMING_CODES.includes(f.code));
    if (!lost && !late) continue;
    items.push({ order, flags, category: lost ? 'lost' : 'late', stakeCents: stakeCents(order), avoidable: flags.length > 0 });
  }
  items.sort((a, b) => b.stakeCents - a.stakeCents || a.order.woNumber.localeCompare(b.order.woNumber));

  const sum = (xs: AuditItem[]) => xs.reduce((s, i) => s + i.stakeCents, 0);
  const lost = items.filter((i) => i.category === 'lost');
  const late = items.filter((i) => i.category === 'late');
  const avoid = items.filter((i) => i.avoidable);
  const rest = items.filter((i) => !i.avoidable);
  const totals: AuditTotals = {
    ordersReviewed: scoped.length,
    lostCount: lost.length, lateCount: late.length, lostCents: sum(lost), lateCents: sum(late), atRiskCents: sum(items),
    avoidableCount: avoid.length, avoidableCents: sum(avoid), unavoidableCount: rest.length, unavoidableCents: sum(rest),
    noAmountCount: items.filter((i) => i.order.invoiceTotalCents == null && i.order.estimateCents == null).length,
  };
  const map = new Map<FlagCode, { count: number; cents: number }>();
  for (const i of items) for (const f of i.flags) {
    const cur = map.get(f.code) ?? { count: 0, cents: 0 };
    map.set(f.code, { count: cur.count + 1, cents: cur.cents + i.stakeCents });
  }
  const byRule = [...map.entries()].map(([code, v]) => ({ code, ...v })).sort((a, b) => b.cents - a.cents || a.code.localeCompare(b.code));
  return { items, totals, byRule };
}

/** { from, to, label } of the calendar quarter before `now` (local dates in `tz`). */
export function previousQuarter(now: Date, tz: string): { from: string; to: string; label: string } {
  const [y, m] = localDate(now.toISOString(), tz).split('-').map(Number);
  const q = Math.floor((m - 1) / 3); // 0..3 current quarter
  const py = q === 0 ? y - 1 : y;
  const pq = q === 0 ? 3 : q - 1;
  const startMonth = pq * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(py, endMonth, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { from: `${py}-${p(startMonth)}-01`, to: `${py}-${p(endMonth)}-${p(lastDay)}`, label: `Q${pq + 1} ${py}` };
}

const csvCell = (v: string | number): string => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection from portal-supplied text
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function auditToCsv(result: AuditResult): string {
  const head = ['WO number', 'Location', 'Priority', 'Outcome', 'Category', 'Amount (USD)', 'Avoidable', 'Rules broken', 'Details'];
  const rows = result.items.map((i) => [
    i.order.woNumber, i.order.location ?? '', i.order.priority, i.order.outcome, i.category,
    (i.stakeCents / 100).toFixed(2), i.avoidable ? 'yes' : 'no', i.flags.map((f) => f.code).join(' | '), i.flags.map((f) => f.detail).join(' | '),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
