/**
 * Portal pre-submission check ("Fix before sending"), "Money at risk" and rejection learning
 * for Work-Order Guard orders. Pure: no I/O, no network, never submits anything.
 *
 * Rules come from the approved compliance catalog (surface "fm_submission", see
 * supabase/functions/_shared/compliance-rules/fmSubmission.ts). Unreviewed rules are never applied.
 * NOT LEGAL ADVICE — these are customer-portal requirements, not law.
 */

import {
  evaluate,
  selectEffective,
} from '../../supabase/functions/_shared/compliance-rules/engine';
import { FM_KINDS, fmDayKey } from '../../supabase/functions/_shared/compliance-rules/fmSubmission';
import type {
  FmDocumentType,
  FmFacts,
  FmFix,
  FmKind,
  FmLineItem,
} from '../../supabase/functions/_shared/compliance-rules/fmSubmission';
import type { RuleVersion, Severity, SourceRef } from '../../supabase/functions/_shared/compliance-rules/types';
import {
  evaluateOrder,
  type FlagCode,
  type PortalRules,
  type WorkOrder,
} from '@/lib/workOrderGuard';

export type { FmFacts, FmFix, FmLineItem, FmDocumentType };

// ---------------------------------------------------------------- facts

export interface FmFactsOptions {
  timezone: string;
  documentType?: FmDocumentType;
  billingParty?: 'portal' | 'customer' | null;
  hasSubcontractor?: boolean;
  attachments?: string[];
  /** true = the invoice is a draft not yet counted in invoiceCount. Default: no invoice submitted yet. */
  isDraft?: boolean;
}

/** Map a Guard work order to the facts the fm_submission rules evaluate. Amounts stay in cents. */
export function orderToFmFacts(o: WorkOrder, opts: FmFactsOptions): FmFacts {
  const lines: FmLineItem[] = [];
  const push = (category: FmLineItem['category'], cents: number | null) => { if (cents != null && cents > 0) lines.push({ category, amountCents: cents }); };
  push('labor', o.invoiceLaborCents);
  push('materials', o.invoiceMaterialsCents);
  push('trip', o.invoiceTripCents);
  push('freight', o.invoiceFreightCents);
  push('sales_tax', o.invoiceTaxCents);
  push('management_fee', o.invoiceMgmtFeeCents);

  const isDraft = opts.isDraft ?? !o.invoiceSubmittedAt;
  const lostInvoice = o.outcome === 'rejected' || o.outcome === 'voided';
  const submitted = isDraft ? o.invoiceCount : Math.max(0, o.invoiceCount - 1);
  const existing = lostInvoice && isDraft ? Math.max(0, submitted - 1) : submitted;

  return {
    documentType: opts.documentType ?? 'invoice',
    workOrderId: o.id,
    timezone: opts.timezone,
    billingParty: opts.billingParty ?? null,
    nteCents: o.nteCents,
    proposalStatus: o.proposalStatus,
    totalCents: o.invoiceTotalCents ?? o.estimateCents,
    partsCents: o.invoiceMaterialsCents,
    lineItems: lines,
    workConfirmedAt: o.completedAt,
    workReceivedAt: o.receivedAt,
    existingInvoiceCount: existing,
    attachments: opts.attachments ?? [],
    hasSubcontractor: opts.hasSubcontractor ?? false,
  };
}

// ---------------------------------------------------------------- pre-submission check

export interface FixItem {
  versionId: string;
  ruleKey: string;
  title: string;
  severity: Severity;
  status: 'fail' | 'action';
  message: string;
  /** Official source(s) the rule cites. */
  sourceRefs: SourceRef[];
  /** Suggested fixes (usually one). Applying a fix edits the DRAFT only. */
  fixes: FmFix[];
}

export interface PreSubmissionResult {
  /** block = fix before sending; allow_with_actions = do these first; allow = nothing found. */
  outcome: 'allow' | 'allow_with_actions' | 'block';
  items: FixItem[];
  passed: number;
  /** How many approved portal rules were evaluated. */
  rulesApplied: number;
  /** True when the catalog holds no approved fm_submission rules: nothing was checked. */
  noActiveRules: boolean;
  /** Informational, e.g. skipped rules. */
  assumptions: string[];
  evaluatedAt: string;
}

const SEV: Record<Severity, number> = { block: 0, require: 1, warn: 2, info: 3 };

export function checkBeforeSending(facts: FmFacts, catalog: readonly RuleVersion[], now: Date = new Date()): PreSubmissionResult {
  const dateKey = fmDayKey(now.toISOString(), facts.timezone ?? 'America/New_York') ?? now.toISOString().slice(0, 10);
  const active = selectEffective(catalog, dateKey).filter((v) => v.appliesTo.includes('fm_submission') && (FM_KINDS as readonly string[]).includes(v.kind));
  const result = evaluate({ surface: 'fm_submission', at: now, fm: facts }, active);
  const items: FixItem[] = [];
  for (const f of result.findings) {
    if (f.status !== 'fail' && f.status !== 'action') continue;
    const fixes = result.actions.filter((a) => a.versionId === f.versionId && a.fix).map((a) => a.fix as FmFix);
    items.push({
      versionId: f.versionId, ruleKey: f.ruleKey, title: f.title, severity: f.severity, status: f.status,
      message: f.message, sourceRefs: f.sourceRefs, fixes,
    });
  }
  items.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.ruleKey.localeCompare(b.ruleKey));
  return {
    outcome: result.outcome,
    items,
    passed: result.findings.filter((f) => f.status === 'pass').length,
    rulesApplied: result.appliedVersionIds.length,
    noActiveRules: active.length === 0,
    assumptions: result.assumptions,
    evaluatedAt: result.evaluatedAt,
  };
}

/** Applies a one-click fix to an in-memory DRAFT. Returns a new list; never mutates, never sends. */
export function applyLineFix(lines: readonly FmLineItem[], fix: FmFix): FmLineItem[] {
  if (fix.kind !== 'remove_line_item' || !fix.oneClick) return [...lines];
  const idx = fix.params?.index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= lines.length) return [...lines];
  return lines.filter((_, i) => i !== idx);
}

// ---------------------------------------------------------------- money at risk

export type RiskBucket = 'ineligible' | 'invoice_overdue' | 'nte_overrun' | 'eligibility_closing' | 'invoice_due_soon' | 'proposal_not_approved';
export type AmountBasis = 'measured' | 'estimated' | 'unknown';

/** Highest priority first: an order's money is counted once, in the first bucket that applies. */
export const BUCKET_PRIORITY: RiskBucket[] = ['ineligible', 'invoice_overdue', 'nte_overrun', 'eligibility_closing', 'invoice_due_soon', 'proposal_not_approved'];

const FLAG_TO_BUCKET: Partial<Record<FlagCode, RiskBucket>> = {
  wo_ineligible: 'ineligible', invoice_overdue: 'invoice_overdue', over_nte: 'nte_overrun',
  wo_expiring_90d: 'eligibility_closing', invoice_due_soon: 'invoice_due_soon',
};

export interface RiskItem {
  woNumber: string;
  orderId: string | null;
  bucket: RiskBucket;
  /** Cents at risk; null when the order has no invoice, estimate or proposal amount. */
  amountCents: number | null;
  /** measured = an actual invoice total or the exact amount over the NTE; estimated = a working estimate or proposal amount. */
  basis: AmountBasis;
  deadline: string | null;
  detail: string;
  /** Counted in the totals (each order once, in its highest-priority bucket). */
  counted: boolean;
}

export interface MoneyAtRisk {
  items: RiskItem[];
  measuredCents: number;
  estimatedCents: number;
  /** Orders at risk with no amount to put a number on. */
  unknownCount: number;
  byBucket: Record<RiskBucket, { count: number; measuredCents: number; estimatedCents: number }>;
}

const emptyBuckets = (): MoneyAtRisk['byBucket'] =>
  Object.fromEntries(BUCKET_PRIORITY.map((b) => [b, { count: 0, measuredCents: 0, estimatedCents: 0 }])) as MoneyAtRisk['byBucket'];

/**
 * Open work orders whose money is at risk, from the account's own Guard rules and data.
 * Never mixes measured and estimated amounts: they are summed separately.
 */
export function moneyAtRisk(orders: readonly WorkOrder[], rules: PortalRules, timezone: string, now: Date = new Date()): MoneyAtRisk {
  const items: RiskItem[] = [];
  const byBucket = emptyBuckets();
  let measuredCents = 0;
  let estimatedCents = 0;
  let unknownCount = 0;

  for (const o of orders) {
    if (o.outcome !== 'open') continue;
    const flags = evaluateOrder(o, { rules, timezone, now });
    const rows: Omit<RiskItem, 'counted'>[] = [];
    for (const f of flags) {
      const bucket = FLAG_TO_BUCKET[f.code];
      if (!bucket) continue;
      const invoiceMeasured = o.invoiceTotalCents != null;
      let amount: number | null; let basis: AmountBasis;
      if (bucket === 'nte_overrun') { amount = f.excessCents > 0 ? f.excessCents : null; basis = invoiceMeasured ? 'measured' : 'estimated'; }
      else if (invoiceMeasured) { amount = o.invoiceTotalCents; basis = 'measured'; }
      else if (o.estimateCents != null) { amount = o.estimateCents; basis = 'estimated'; }
      else if (o.proposalAmountCents != null && o.proposalStatus === 'approved') { amount = o.proposalAmountCents; basis = 'estimated'; }
      else { amount = null; basis = 'unknown'; }
      rows.push({ woNumber: o.woNumber, orderId: o.id ?? null, bucket, amountCents: amount, basis, deadline: f.deadline, detail: f.detail });
    }
    if ((o.proposalStatus === 'pending' || o.proposalStatus === 'rejected') && (o.checkedInAt || o.completedAt)) {
      rows.push({
        woNumber: o.woNumber, orderId: o.id ?? null, bucket: 'proposal_not_approved',
        amountCents: o.proposalAmountCents, basis: o.proposalAmountCents != null ? 'estimated' : 'unknown', deadline: null,
        detail: `Work started while the proposal is ${o.proposalStatus}.`,
      });
    }
    if (rows.length === 0) continue;
    rows.sort((a, b) => BUCKET_PRIORITY.indexOf(a.bucket) - BUCKET_PRIORITY.indexOf(b.bucket));
    rows.forEach((r, i) => {
      const counted = i === 0;
      items.push({ ...r, counted });
      if (!counted) return;
      const b = byBucket[r.bucket];
      b.count += 1;
      if (r.basis === 'measured' && r.amountCents != null) { b.measuredCents += r.amountCents; measuredCents += r.amountCents; }
      else if (r.basis === 'estimated' && r.amountCents != null) { b.estimatedCents += r.amountCents; estimatedCents += r.amountCents; }
      else unknownCount += 1;
    });
  }
  items.sort((a, b) => BUCKET_PRIORITY.indexOf(a.bucket) - BUCKET_PRIORITY.indexOf(b.bucket) || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || a.woNumber.localeCompare(b.woNumber));
  return { items, measuredCents, estimatedCents, unknownCount, byBucket };
}

// ---------------------------------------------------------------- rejection learning

export interface RuleCandidate {
  candidateKey: string;
  kind: FmKind;
  /** Suggested params for a reviewer to start from. NOT a rule: it is never saved or enforced by this code. */
  suggestedParams: Record<string, unknown>;
  evidenceCount: number;
  exampleReasons: string[];
  /** An approved or in-review rule of this kind already exists in the catalog. */
  alreadyCovered: boolean;
}

interface Pattern { key: string; kind: FmKind; re: RegExp; params: Record<string, unknown> }
const PATTERNS: Pattern[] = [
  { key: 'sales-tax', kind: 'fm_prohibited_line_item', re: /\b(sales\s*tax|tax(es)?)\b/i, params: { categories: ['sales_tax'] } },
  { key: 'fee-line', kind: 'fm_prohibited_line_item', re: /\b(new business fee|management fee|admin(istrative)? fee|fuel surcharge|surcharge|markup)\b/i, params: { categories: ['new_business_fee'] } },
  { key: 'over-nte', kind: 'fm_nte_cap', re: /\b(nte|not[- ]to[- ]exceed|exceed(s|ed)?|over (the )?(limit|budget|nte))\b/i, params: {} },
  { key: 'duplicate', kind: 'fm_single_invoice', re: /\b(duplicate|already (been )?invoiced|second invoice|multiple invoices)\b/i, params: {} },
  { key: 'late', kind: 'fm_invoice_deadline', re: /\b(late|past due|too old|outside (the )?(window|timeframe)|days? (after|since))\b/i, params: { days: 10, anchor: 'work_confirmed' } },
  { key: 'attachment', kind: 'fm_required_attachment', re: /\b(attach(ment|ed)?|backup|sub(contractor)?'?s? invoice|photo|signed|signature|missing doc)/i, params: { attachment: 'REVIEWER_TO_NAME', label: 'REVIEWER_TO_NAME' } },
];

/**
 * Groups the account's own rejection reasons into CANDIDATE rules for human review.
 * Keyword grouping is a heuristic: candidates are suggestions, never rules, and are never saved or activated here.
 */
export function suggestRuleCandidates(orders: readonly WorkOrder[], catalog: readonly RuleVersion[], minEvidence = 2): RuleCandidate[] {
  const covered = new Set(catalog.filter((v) => v.appliesTo.includes('fm_submission') && v.status !== 'rejected' && v.status !== 'retired').map((v) => v.kind));
  const groups = new Map<string, { p: Pattern; reasons: string[] }>();
  for (const o of orders) {
    if (o.outcome !== 'rejected') continue;
    const reason = (o.outcomeReason ?? '').replace(/\s+/g, ' ').trim();
    if (!reason) continue;
    const p = PATTERNS.find((x) => x.re.test(reason));
    if (!p) continue;
    const g = groups.get(p.key) ?? { p, reasons: [] };
    g.reasons.push(reason.length > 160 ? `${reason.slice(0, 157)}…` : reason);
    groups.set(p.key, g);
  }
  return [...groups.values()]
    .filter((g) => g.reasons.length >= minEvidence)
    .map((g) => ({
      candidateKey: g.p.key, kind: g.p.kind, suggestedParams: g.p.params, evidenceCount: g.reasons.length,
      exampleReasons: [...new Set(g.reasons)].slice(0, 3), alreadyCovered: covered.has(g.p.kind),
    }))
    .sort((a, b) => b.evidenceCount - a.evidenceCount || a.candidateKey.localeCompare(b.candidateKey));
}
