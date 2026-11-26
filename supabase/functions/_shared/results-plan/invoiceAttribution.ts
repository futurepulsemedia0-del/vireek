// Outcome-Based Pricing (Task E) — invoice-recovery attribution, fee math and baseline comparison.
// PURE: no I/O, no clock, no randomness. Every number below marked PLACEHOLDER is not an approved policy.
// Design goals: conservative by default, every decision carries its reasons, nothing is counted twice.

export const OUTCOME_RULE_VERSION = 'oc-rules-v1';

const DAY_MS = 86_400_000;

// ============================================================
// TYPES
// ============================================================

export type ActionType = 'fix' | 'resubmit' | 'follow_up' | 'escalation';
export type ActionActor = 'vireek' | 'human' | 'other_system';
export type InvoiceStatus = 'open' | 'paid' | 'void' | 'written_off';

export interface InvoicePayment {
  id: string;
  at: string;
  cents: number;
}

export interface InvoiceFacts {
  id: string;
  issuedAt: string;
  /** null = due date unknown; then "paid within normal terms" cannot be ruled out and nothing is attributed. */
  dueAt: string | null;
  totalCents: number;
  status: InvoiceStatus;
  payments: readonly InvoicePayment[];
  rejectedAt: string | null;
  rejectionClearedAt: string | null;
  disputed: boolean;
  creditedCents: number;
  isTest: boolean;
}

export interface LoggedAction {
  id: string;
  invoiceId: string;
  type: ActionType;
  at: string;
  actor: ActionActor;
  /** What the action log recorded at action time (evidence). It is never trusted alone for condition (ii). */
  riskSnapshot: 'at_risk' | 'not_at_risk' | null;
}

export interface HumanConfirmation {
  invoiceId: string;
  confirmedAt: string;
  confirmedBy: string;
}

export type ConfirmationMode = 'human_only' | 'human_or_complete_chain';

export interface AttributionRules {
  /** Invoice older than this many days (strictly) at action time is "at risk". PLACEHOLDER. */
  atRiskDays: number;
  /** A payment counts only if it arrives within this many days after the action. PLACEHOLDER. */
  attributionWindowDays: number;
  confirmationMode: ConfirmationMode;
}

export const ATTRIBUTION_DEFAULTS: AttributionRules = {
  atRiskDays: 30,
  attributionWindowDays: 60,
  confirmationMode: 'human_or_complete_chain',
};

export type ExclusionReason =
  | 'invalid_timestamp'
  | 'duplicate_invoice_input'
  | 'test_invoice'
  | 'invoice_void_or_written_off'
  | 'invoice_disputed'
  | 'credited'
  | 'no_vireek_action'
  | 'not_at_risk_at_action'
  | 'no_payment_after_action'
  | 'payment_outside_window'
  | 'due_date_unknown'
  | 'paid_within_terms'
  | 'not_confirmed_or_incomplete_chain'
  | 'already_counted';

export interface AttributionDecision {
  invoiceId: string;
  qualifies: boolean;
  reasons: ExclusionReason[];
  conditions: {
    vireekAction: boolean;
    atRiskAtAction: boolean;
    paidAfterAction: boolean;
    confirmedOrComplete: boolean;
  };
  primaryActionId: string | null;
  primaryActionAt: string | null;
  paymentIds: string[];
  recoveredCents: number;
  confirmationBasis: 'human' | 'evidence_chain' | null;
  ruleVersion: string;
}

// ============================================================
// ATTRIBUTION
// ============================================================

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
}

/** At-risk at time `at`: unpaid-in-full at that moment AND (older than atRiskDays OR carrying an uncleared rejection). */
export function isAtRisk(inv: InvoiceFacts, at: string, rules: AttributionRules): boolean {
  const atMs = ms(at);
  const issued = ms(inv.issuedAt);
  if (atMs === null || issued === null || atMs < issued) return false;
  const paidBefore = inv.payments.reduce((s, p) => ((ms(p.at) ?? Infinity) < atMs ? s + p.cents : s), 0);
  if (paidBefore >= inv.totalCents) return false;
  const ageDays = (atMs - issued) / DAY_MS;
  const rej = ms(inv.rejectedAt);
  const cleared = ms(inv.rejectionClearedAt);
  const rejectedOpen = rej !== null && rej <= atMs && (cleared === null || cleared > atMs);
  return ageDays > rules.atRiskDays || rejectedOpen;
}

function emptyDecision(invoiceId: string, reasons: ExclusionReason[]): AttributionDecision {
  return {
    invoiceId,
    qualifies: false,
    reasons,
    conditions: { vireekAction: false, atRiskAtAction: false, paidAfterAction: false, confirmedOrComplete: false },
    primaryActionId: null,
    primaryActionAt: null,
    paymentIds: [],
    recoveredCents: 0,
    confirmationBasis: null,
    ruleVersion: OUTCOME_RULE_VERSION,
  };
}

export function attributeInvoice(
  inv: InvoiceFacts,
  actions: readonly LoggedAction[],
  confirmation: HumanConfirmation | null,
  rules: AttributionRules,
  alreadyCountedCents = 0,
): AttributionDecision {
  const mine = actions.filter((a) => a.invoiceId === inv.id);
  const tsOk =
    ms(inv.issuedAt) !== null &&
    (inv.dueAt === null || ms(inv.dueAt) !== null) &&
    inv.payments.every((p) => ms(p.at) !== null && Number.isInteger(p.cents) && p.cents > 0) &&
    mine.every((a) => ms(a.at) !== null) &&
    Number.isInteger(inv.totalCents) && inv.totalCents > 0 &&
    Number.isInteger(alreadyCountedCents) && alreadyCountedCents >= 0;
  if (!tsOk) return emptyDecision(inv.id, ['invalid_timestamp']);

  const reasons: ExclusionReason[] = [];
  if (inv.isTest) reasons.push('test_invoice');
  if (inv.status === 'void' || inv.status === 'written_off') reasons.push('invoice_void_or_written_off');
  if (inv.disputed) reasons.push('invoice_disputed');
  if (inv.creditedCents > 0) reasons.push('credited');

  // (i) a logged Vireek action
  const vireek = mine.filter((a) => a.actor === 'vireek').sort((a, b) => (ms(a.at) as number) - (ms(b.at) as number));
  const c1 = vireek.length > 0;
  if (!c1) reasons.push('no_vireek_action');

  // (ii) invoice was at risk when the action happened (recomputed from facts, not from the snapshot)
  const qualifying = vireek.filter((a) => isAtRisk(inv, a.at, rules));
  const c2 = qualifying.length > 0;
  if (c1 && !c2) reasons.push('not_at_risk_at_action');

  // (iii) payment afterwards, inside the window, and not within normal terms
  const dueMs = ms(inv.dueAt);
  const windowMs = rules.attributionWindowDays * DAY_MS;
  let sawAfter = false;
  let sawInWindow = false;
  let sawOutsideTerms = false;
  const eligible: InvoicePayment[] = [];
  for (const p of inv.payments) {
    const pMs = ms(p.at) as number;
    const covering = qualifying.filter((a) => {
      const aMs = ms(a.at) as number;
      return pMs >= aMs;
    });
    if (covering.length === 0) continue;
    sawAfter = true;
    const inWin = covering.some((a) => pMs <= (ms(a.at) as number) + windowMs);
    if (!inWin) continue;
    sawInWindow = true;
    if (dueMs === null || pMs <= dueMs) continue;
    sawOutsideTerms = true;
    eligible.push(p);
  }
  if (c2 && !sawAfter) reasons.push('no_payment_after_action');
  else if (c2 && !sawInWindow) reasons.push('payment_outside_window');
  else if (c2 && sawInWindow && !sawOutsideTerms) reasons.push(dueMs === null ? 'due_date_unknown' : 'paid_within_terms');
  const c3 = eligible.length > 0;

  // Primary action = latest qualifying action not after the earliest eligible payment.
  let primary: LoggedAction | null = null;
  if (c3) {
    const firstPay = Math.min(...eligible.map((p) => ms(p.at) as number));
    for (const a of qualifying) if ((ms(a.at) as number) <= firstPay) primary = a;
  }

  // (iv) a human confirmed, or the evidence chain is complete
  let basis: 'human' | 'evidence_chain' | null = null;
  if (confirmation && confirmation.invoiceId === inv.id && ms(confirmation.confirmedAt) !== null && confirmation.confirmedBy.trim() !== '') {
    basis = 'human';
  } else if (
    rules.confirmationMode === 'human_or_complete_chain' &&
    primary !== null &&
    primary.riskSnapshot === 'at_risk' &&
    dueMs !== null &&
    eligible.every((p) => p.id.trim() !== '')
  ) {
    basis = 'evidence_chain';
  }
  const c4 = basis !== null;
  if (c1 && c2 && c3 && !c4) reasons.push('not_confirmed_or_incomplete_chain');

  // Amount: eligible payments only, capped at the invoice total, minus what earlier statements already counted.
  const eligibleSum = eligible.reduce((s, p) => s + p.cents, 0);
  const gross = Math.min(eligibleSum, inv.totalCents);
  const recovered = Math.max(0, gross - alreadyCountedCents);
  if (c3 && recovered === 0) reasons.push('already_counted');

  const qualifies = reasons.length === 0;
  return {
    invoiceId: inv.id,
    qualifies,
    reasons,
    conditions: { vireekAction: c1, atRiskAtAction: c2, paidAfterAction: c3, confirmedOrComplete: c4 },
    primaryActionId: primary ? primary.id : null,
    primaryActionAt: primary ? primary.at : null,
    paymentIds: eligible.map((p) => p.id),
    recoveredCents: qualifies ? recovered : 0,
    confirmationBasis: basis,
    ruleVersion: OUTCOME_RULE_VERSION,
  };
}

/** One decision per distinct invoice id (output sorted by id). A repeated id is excluded, never double counted. */
export function attributeAll(
  invoices: readonly InvoiceFacts[],
  actions: readonly LoggedAction[],
  confirmations: readonly HumanConfirmation[],
  rules: AttributionRules,
  alreadyCounted: Readonly<Record<string, number>> = {},
): AttributionDecision[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const unique: InvoiceFacts[] = [];
  for (const inv of invoices) {
    if (seen.has(inv.id)) dupes.add(inv.id);
    else { seen.add(inv.id); unique.push(inv); }
  }
  const confById = new Map(confirmations.map((c) => [c.invoiceId, c] as const));
  return unique
    .map((inv) =>
      dupes.has(inv.id)
        ? emptyDecision(inv.id, ['duplicate_invoice_input'])
        : attributeInvoice(inv, actions, confById.get(inv.id) ?? null, rules, alreadyCounted[inv.id] ?? 0),
    )
    .sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0));
}

/** Contested lines are held out of billing until resolved. */
export function billableDecisions(decisions: readonly AttributionDecision[], contestedInvoiceIds: ReadonlySet<string>): AttributionDecision[] {
  return decisions.filter((d) => d.qualifies && !contestedInvoiceIds.has(d.invoiceId));
}

// ============================================================
// FEE TERMS & MATH (integer cents, half-up rounding)
// ============================================================

export type OutcomeModel = 'recovered_pct' | 'first_pass_per_invoice' | 'none';

export interface FeeTerms {
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  model: OutcomeModel;
  baseFeeCents: number;
  /** recovered_pct: basis points of recovered cents (1500 = 15%). */
  pctBps: number;
  /** first_pass_per_invoice: cents per invoice accepted first-pass above baseline. */
  perInvoiceCents: number;
  /** Minimum outcome fee, applied only when at least one billable outcome exists. */
  outcomeFloorCents: number;
  outcomeCapCents: number | null;
  /** Ceiling on base + outcome for the statement. */
  monthlyMaxTotalCents: number | null;
  pilotFreeUntil: string | null;
  noFeeFirstDays: number;
}

export function validateFeeTerms(t: FeeTerms): string[] {
  const bad: string[] = [];
  const nonNegInt = (n: number) => Number.isInteger(n) && n >= 0;
  if (!Number.isInteger(t.version) || t.version < 1) bad.push('version');
  if (ms(t.effectiveFrom) === null) bad.push('effectiveFrom');
  if (t.effectiveTo !== null && (ms(t.effectiveTo) === null || (ms(t.effectiveTo) as number) <= (ms(t.effectiveFrom) ?? Infinity))) bad.push('effectiveTo');
  if (!nonNegInt(t.baseFeeCents)) bad.push('baseFeeCents');
  if (!nonNegInt(t.pctBps) || t.pctBps > 10_000) bad.push('pctBps');
  if (!nonNegInt(t.perInvoiceCents)) bad.push('perInvoiceCents');
  if (!nonNegInt(t.outcomeFloorCents)) bad.push('outcomeFloorCents');
  if (t.outcomeCapCents !== null && !nonNegInt(t.outcomeCapCents)) bad.push('outcomeCapCents');
  if (t.outcomeCapCents !== null && t.outcomeFloorCents > t.outcomeCapCents) bad.push('floor_above_cap');
  if (t.monthlyMaxTotalCents !== null && !nonNegInt(t.monthlyMaxTotalCents)) bad.push('monthlyMaxTotalCents');
  if (t.pilotFreeUntil !== null && ms(t.pilotFreeUntil) === null) bad.push('pilotFreeUntil');
  if (!nonNegInt(t.noFeeFirstDays)) bad.push('noFeeFirstDays');
  if (t.model === 'recovered_pct' && t.pctBps === 0) bad.push('pct_model_zero_rate');
  if (t.model === 'first_pass_per_invoice' && t.perInvoiceCents === 0) bad.push('first_pass_model_zero_price');
  if (t.model === 'none' && (t.pctBps !== 0 || t.perInvoiceCents !== 0 || t.outcomeFloorCents !== 0)) bad.push('none_model_has_outcome_price');
  return bad;
}

/** Terms in force at `at` (effectiveFrom <= at < effectiveTo). Highest version wins on overlap. null if none. */
export function pickTerms(versions: readonly FeeTerms[], at: string): FeeTerms | null {
  const atMs = ms(at);
  if (atMs === null) return null;
  let best: FeeTerms | null = null;
  for (const v of versions) {
    const from = ms(v.effectiveFrom);
    const to = ms(v.effectiveTo);
    if (from === null || from > atMs) continue;
    if (v.effectiveTo !== null && (to === null || atMs >= to)) continue;
    if (best === null || v.version > best.version) best = v;
  }
  return best;
}

/** Half-up integer rounding of cents * bps / 10000. Inputs are integers well inside 2^53. */
export function pctOfCents(cents: number, bps: number): number {
  return Math.floor((cents * bps + 5_000) / 10_000);
}

export interface FirstPassInput {
  acceptedFirstPass: number;
  submitted: number;
  /** Baseline first-pass acceptance in basis points; null = baseline missing. */
  baselineRateBps: number | null;
}

export interface FeeContext {
  enabled: boolean;
  /** Reason string when measurement is unreliable (Task C data-quality) — suspends the outcome fee only. */
  suspendedReason: string | null;
  enrolledAt: string;
  periodStart: string;
  periodEnd: string;
  billable: readonly AttributionDecision[];
  firstPass: FirstPassInput | null;
}

export type ZeroReason = 'disabled' | 'suspended' | 'model_none' | 'no_billable' | 'baseline_missing' | 'fee_free_period' | 'invalid_terms';

export interface FeeLine {
  invoiceId: string;
  recoveredCents: number;
  feeCents: number;
  feeFree: boolean;
}

export interface FeeResult {
  baseFeeCents: number;
  outcomeFeeCents: number;
  totalCents: number;
  lines: FeeLine[];
  rawLinesCents: number;
  /** outcomeFeeCents - rawLinesCents: negative = cap, positive = floor. Keeps the statement auditable. */
  adjustmentCents: number;
  appliedFloor: boolean;
  appliedCap: boolean;
  appliedMonthlyMax: boolean;
  zeroReason: ZeroReason | null;
  firstPassBasis: { expectedAtBaseline: number; aboveBaseline: number } | null;
}

const zeroFee = (reason: ZeroReason, base = 0): FeeResult => ({
  baseFeeCents: base, outcomeFeeCents: 0, totalCents: base, lines: [], rawLinesCents: 0, adjustmentCents: 0,
  appliedFloor: false, appliedCap: false, appliedMonthlyMax: false, zeroReason: reason, firstPassBasis: null,
});

export function computeFee(t: FeeTerms, c: FeeContext): FeeResult {
  if (!c.enabled) return zeroFee('disabled');
  if (validateFeeTerms(t).length > 0) return zeroFee('invalid_terms');

  const enrolled = ms(c.enrolledAt);
  const pStart = ms(c.periodStart);
  const pEnd = ms(c.periodEnd);
  if (enrolled === null || pStart === null || pEnd === null || pEnd <= pStart) return zeroFee('invalid_terms');

  const pilot = ms(t.pilotFreeUntil);
  const cutoff = Math.max(pilot ?? -Infinity, enrolled + t.noFeeFirstDays * DAY_MS);
  const baseFree = pEnd <= cutoff;
  const base = baseFree ? 0 : t.baseFeeCents;

  if (c.suspendedReason !== null) return zeroFee('suspended', base);
  if (t.model === 'none') return zeroFee('model_none', base);

  let lines: FeeLine[] = [];
  let raw = 0;
  let any = false;
  let fpBasis: FeeResult['firstPassBasis'] = null;

  if (t.model === 'recovered_pct') {
    lines = c.billable.map((d) => {
      const at = ms(d.primaryActionAt);
      const feeFree = at === null || at < cutoff;
      return { invoiceId: d.invoiceId, recoveredCents: d.recoveredCents, feeCents: feeFree ? 0 : pctOfCents(d.recoveredCents, t.pctBps), feeFree };
    });
    raw = lines.reduce((s, l) => s + l.feeCents, 0);
    any = lines.some((l) => !l.feeFree && l.recoveredCents > 0);
    if (c.billable.length === 0) return zeroFee('no_billable', base);
  } else {
    const fp = c.firstPass;
    if (fp === null || fp.baselineRateBps === null) return zeroFee('baseline_missing', base);
    if (!Number.isInteger(fp.acceptedFirstPass) || !Number.isInteger(fp.submitted) || fp.acceptedFirstPass < 0 || fp.submitted < 0 || fp.acceptedFirstPass > fp.submitted) {
      return zeroFee('invalid_terms', base);
    }
    if (pStart < cutoff) return zeroFee('fee_free_period', base);
    const expected = Math.ceil((fp.submitted * fp.baselineRateBps) / 10_000);
    const above = Math.max(0, fp.acceptedFirstPass - expected);
    fpBasis = { expectedAtBaseline: expected, aboveBaseline: above };
    raw = above * t.perInvoiceCents;
    any = above > 0;
    if (!any) return { ...zeroFee('no_billable', base), firstPassBasis: fpBasis };
  }

  let outcome = raw;
  let appliedFloor = false;
  let appliedCap = false;
  if (any && outcome < t.outcomeFloorCents) { outcome = t.outcomeFloorCents; appliedFloor = true; }
  if (t.outcomeCapCents !== null && outcome > t.outcomeCapCents) { outcome = t.outcomeCapCents; appliedCap = true; }

  let appliedMonthlyMax = false;
  let baseOut = base;
  if (t.monthlyMaxTotalCents !== null && base + outcome > t.monthlyMaxTotalCents) {
    baseOut = Math.min(base, t.monthlyMaxTotalCents);
    outcome = Math.max(0, t.monthlyMaxTotalCents - baseOut);
    appliedMonthlyMax = true;
  }

  return {
    baseFeeCents: baseOut,
    outcomeFeeCents: outcome,
    totalCents: baseOut + outcome,
    lines,
    rawLinesCents: raw,
    adjustmentCents: outcome - raw,
    appliedFloor,
    appliedCap,
    appliedMonthlyMax,
    zeroReason: outcome === 0 && !any ? (baseFree ? 'fee_free_period' : 'no_billable') : null,
    firstPassBasis: fpBasis,
  };
}

// ============================================================
// BASELINE COMPARISON — descriptive only, never causal
// ============================================================

export interface MetricSample { value: number | null; n: number }
export interface RateSample { accepted: number; total: number }

export interface BaselineMetrics {
  dsoDays: MetricSample;
  over30ArCents: MetricSample;
  firstPass: RateSample;
}

export type SampleLabel = 'insufficient' | 'adequate';
export type ChangeLabel = 'insufficient_data' | 'observed_lower' | 'observed_higher' | 'unchanged' | 'no_clear_change';

export interface MetricComparison {
  baseline: number | null;
  current: number | null;
  delta: number | null;
  baselineN: number;
  currentN: number;
  sample: SampleLabel;
  change: ChangeLabel;
}

export interface BaselineComparison {
  status: 'baseline_missing' | 'insufficient_data' | 'compared';
  /** Always false: this comparison is observational and does not establish that Vireek caused the change. */
  causal: false;
  dso: MetricComparison;
  over30Ar: MetricComparison;
  firstPass: MetricComparison & { baselineCi: [number, number] | null; currentCi: [number, number] | null };
}

export const MIN_SAMPLE_DEFAULT = 30;

/** 95% Wilson score interval for a proportion. */
export function wilson95(accepted: number, total: number): [number, number] | null {
  if (!Number.isInteger(accepted) || !Number.isInteger(total) || total <= 0 || accepted < 0 || accepted > total) return null;
  const z = 1.959964;
  const p = accepted / total;
  const d = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function compareValue(b: MetricSample, c: MetricSample, min: number): MetricComparison {
  const ok = b.value !== null && c.value !== null && b.n >= min && c.n >= min;
  const delta = b.value !== null && c.value !== null ? c.value - b.value : null;
  return {
    baseline: b.value, current: c.value, delta, baselineN: b.n, currentN: c.n,
    sample: ok ? 'adequate' : 'insufficient',
    change: !ok || delta === null ? 'insufficient_data' : delta < 0 ? 'observed_lower' : delta > 0 ? 'observed_higher' : 'unchanged',
  };
}

export function compareToBaseline(base: BaselineMetrics | null, cur: BaselineMetrics, minSample = MIN_SAMPLE_DEFAULT): BaselineComparison {
  const emptyMetric = (n: number): MetricComparison => ({ baseline: null, current: null, delta: null, baselineN: 0, currentN: n, sample: 'insufficient', change: 'insufficient_data' });
  if (base === null) {
    return {
      status: 'baseline_missing', causal: false,
      dso: emptyMetric(cur.dsoDays.n), over30Ar: emptyMetric(cur.over30ArCents.n),
      firstPass: { ...emptyMetric(cur.firstPass.total), baselineCi: null, currentCi: wilson95(cur.firstPass.accepted, cur.firstPass.total) },
    };
  }
  const dso = compareValue(base.dsoDays, cur.dsoDays, minSample);
  const over30Ar = compareValue(base.over30ArCents, cur.over30ArCents, minSample);

  const bCi = wilson95(base.firstPass.accepted, base.firstPass.total);
  const cCi = wilson95(cur.firstPass.accepted, cur.firstPass.total);
  const enough = bCi !== null && cCi !== null && base.firstPass.total >= minSample && cur.firstPass.total >= minSample;
  const bRate = base.firstPass.total > 0 ? base.firstPass.accepted / base.firstPass.total : null;
  const cRate = cur.firstPass.total > 0 ? cur.firstPass.accepted / cur.firstPass.total : null;
  let change: ChangeLabel = 'insufficient_data';
  if (enough && bCi && cCi) {
    change = cCi[0] > bCi[1] ? 'observed_higher' : cCi[1] < bCi[0] ? 'observed_lower' : 'no_clear_change';
  }
  const firstPass = {
    baseline: bRate, current: cRate, delta: bRate !== null && cRate !== null ? cRate - bRate : null,
    baselineN: base.firstPass.total, currentN: cur.firstPass.total,
    sample: (enough ? 'adequate' : 'insufficient') as SampleLabel, change, baselineCi: bCi, currentCi: cCi,
  };

  const anyEnough = dso.sample === 'adequate' || over30Ar.sample === 'adequate' || firstPass.sample === 'adequate';
  return { status: anyEnough ? 'compared' : 'insufficient_data', causal: false, dso, over30Ar, firstPass };
}
