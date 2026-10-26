/**
 * Enterprise Value & Exit-Readiness — pure logic (no React, no Supabase).
 *
 * Everything deterministic lives here so it is unit-tested: earnings (SDE / EBITDA with
 * documented add-backs), valuation ranges, driver scoring, the sell-readiness score, the ranked
 * action plan and the what-if simulator. Fetching lives in exitReadinessApi.ts.
 *
 * ALL OUTPUTS ARE ESTIMATES. They are not an appraisal, a valuation opinion, tax, legal or
 * financial advice. Multiples are illustrative starting ranges the owner can (and should) edit.
 *
 * Method is disclosed, not hidden:
 *   net income      = TTM revenue − TTM expenses (posted journal entries)
 *   SDE             = net income + interest + taxes + D&A (ledger-detected) + documented add-backs
 *   Adjusted EBITDA = SDE − market-rate salary for an owner-replacement manager
 *   value range     = earnings × (low … high multiple); point estimate sits inside the range
 *                     according to the sell-readiness score (can be switched off → mid multiple).
 * A driver with no data is left out of the score and the remaining weights are re-normalised.
 */

export const ESTIMATE_DISCLAIMER =
  'Estimate only. This is not a valuation, appraisal, tax, legal or financial advice. ' +
  'Figures come from your own records and editable assumptions; real sale prices depend on buyer, ' +
  'structure, diligence and market conditions. Talk to a qualified broker or advisor before acting.';

// ============================================================
// TYPES
// ============================================================

export type IndustryKey = 'hvac' | 'plumbing' | 'electrical' | 'roofing' | 'general_trades' | 'custom';
export type ValuationMethod = 'auto' | 'sde' | 'ebitda';
export type DriverKey =
  | 'recurring_revenue'
  | 'customer_concentration'
  | 'workforce'
  | 'owner_dependence'
  | 'dso'
  | 'gross_margin'
  | 'documentation'
  | 'compliance'
  | 'data_quality';
export type DriverStatus = 'strong' | 'ok' | 'weak' | 'nodata';
export type Confidence = 'low' | 'medium' | 'high';

export interface MultipleRange {
  low: number;
  mid: number;
  high: number;
}

export interface IndustryPreset {
  key: IndustryKey;
  label: string;
  sde: MultipleRange;
  ebitda: MultipleRange;
}

/** Illustrative starting points only — replace with figures from your broker / advisor. */
export const INDUSTRY_PRESETS: Record<IndustryKey, IndustryPreset> = {
  hvac: { key: 'hvac', label: 'HVAC', sde: { low: 2.0, mid: 2.8, high: 3.5 }, ebitda: { low: 4.0, mid: 5.5, high: 7.0 } },
  plumbing: { key: 'plumbing', label: 'Plumbing', sde: { low: 1.8, mid: 2.5, high: 3.2 }, ebitda: { low: 3.5, mid: 5.0, high: 6.5 } },
  electrical: { key: 'electrical', label: 'Electrical', sde: { low: 1.8, mid: 2.5, high: 3.2 }, ebitda: { low: 3.5, mid: 5.0, high: 6.5 } },
  roofing: { key: 'roofing', label: 'Roofing', sde: { low: 1.5, mid: 2.2, high: 3.0 }, ebitda: { low: 3.0, mid: 4.0, high: 5.5 } },
  general_trades: { key: 'general_trades', label: 'General home services', sde: { low: 1.5, mid: 2.3, high: 3.0 }, ebitda: { low: 3.0, mid: 4.2, high: 5.5 } },
  custom: { key: 'custom', label: 'Custom (your own multiples)', sde: { low: 2.0, mid: 2.5, high: 3.0 }, ebitda: { low: 3.5, mid: 4.5, high: 5.5 } },
};

/** Under this SDE (USD cents) the "auto" method uses SDE; at or above it uses adjusted EBITDA. */
export const AUTO_METHOD_SDE_THRESHOLD_CENTS = 75_000_000;

export interface ExitSettings {
  industryKey: IndustryKey;
  method: ValuationMethod;
  sdeMultiple: MultipleRange | null;
  ebitdaMultiple: MultipleRange | null;
  ownerMarketSalaryCents: number;
  ownerWeeklyHours: number | null;
  readinessAdjusts: boolean;
}

export const DEFAULT_SETTINGS: ExitSettings = {
  industryKey: 'hvac',
  method: 'auto',
  sdeMultiple: null,
  ebitdaMultiple: null,
  ownerMarketSalaryCents: 0,
  ownerWeeklyHours: null,
  readinessAdjusts: true,
};

export type AddBackKind =
  | 'owner_compensation'
  | 'owner_perquisite'
  | 'one_time'
  | 'non_cash'
  | 'interest'
  | 'taxes'
  | 'depreciation'
  | 'other'
  | 'deduction';

export const ADDBACK_KIND_LABELS: Record<AddBackKind, string> = {
  owner_compensation: 'Owner compensation',
  owner_perquisite: 'Owner perquisite (personal expense in the business)',
  one_time: 'One-time / non-recurring expense',
  non_cash: 'Non-cash expense',
  interest: 'Interest (not already in the ledger accounts)',
  taxes: 'Income taxes (not already in the ledger accounts)',
  depreciation: 'Depreciation / amortisation (not already in the ledger accounts)',
  other: 'Other add-back',
  deduction: 'Deduction (one-time income or under-booked cost)',
};

export interface AddBack {
  id: string;
  kind: AddBackKind;
  label: string;
  /** Signed. Add-backs are positive; `deduction` is negative. */
  amountCents: number;
  justification: string;
  evidenceRef: string | null;
  active: boolean;
}

export interface MonthPoint {
  month: string;
  revenueCents: number;
  expensesCents: number;
}

export interface ServiceMargin {
  service: string;
  revenueCents: number;
  costCents: number;
  marginPct: number | null;
  jobs: number;
}

/** Shape returned by the exit_get_metrics() RPC (camelCase on purpose). */
export interface ExitMetrics {
  generatedAt: string;
  ledgerMonths: number;
  financials: {
    revenueCents: number;
    expensesCents: number;
    interestCents: number;
    taxCents: number;
    daCents: number;
    monthly: MonthPoint[];
  };
  recurringShare: number | null;
  recurringAnnualCents: number;
  concentration: { top1: number | null; top5: number | null; customers: number };
  workforce: { headcount: number; avgTenureYears: number | null; turnoverRate: number | null };
  ownerDependence: { revenueShare: number | null };
  dso: number | null;
  arOpenCents: number;
  margin: { overall: number | null; coveragePct: number | null; byService: ServiceMargin[] };
  documentation: { published: number; categories: number; ackRate: number | null };
  compliance: {
    credentialsTotal: number;
    credentialsValid: number;
    credentialsExpiring: number;
    credentialsExpired: number;
    insuranceTotal: number;
    insuranceValid: number;
    hasGeneralLiability: boolean;
  };
}

export interface ModelInput {
  metrics: ExitMetrics;
  settings: ExitSettings;
  addBacks: AddBack[];
  /** 0–100 from the Data Quality Center, or null when it could not be computed. */
  dataQuality: number | null;
}

export interface Earnings {
  netIncomeCents: number;
  autoAddBacksCents: number;
  manualAddBacksCents: number;
  sdeCents: number;
  ownerSalaryCents: number;
  ebitdaCents: number;
}

export interface Valuation {
  method: 'sde' | 'ebitda';
  earningsCents: number;
  multiple: MultipleRange;
  /** Multiple actually applied to the point estimate. */
  pointMultiple: number;
  lowCents: number;
  midCents: number;
  highCents: number;
  pointCents: number;
  /** Set when no estimate can be produced (non-positive earnings). */
  reason: string | null;
}

export interface DriverResult {
  key: DriverKey;
  label: string;
  weight: number;
  /** 0–100, null when there is no data. */
  score: number | null;
  status: DriverStatus;
  /** Human readable current value, e.g. "18% of revenue". */
  display: string;
  detail: string;
}

export interface Readiness {
  score: number | null;
  /** Share (0–1) of total driver weight that had data. */
  coverage: number;
  grade: 'sale_ready' | 'nearly_ready' | 'needs_work' | 'early_stage' | 'unknown';
}

export interface Evaluation {
  earnings: Earnings;
  drivers: DriverResult[];
  readiness: Readiness;
  valuation: Valuation;
  confidence: Confidence;
}

// ============================================================
// SMALL HELPERS
// ============================================================

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Linear 0–100 score: `bad` → 0, `good` → 100 (works in either direction), clamped. */
export function lin(x: number, bad: number, good: number): number {
  if (bad === good) return x >= good ? 100 : 0;
  return clamp(((x - bad) / (good - bad)) * 100, 0, 100);
}

export function fmtMoney(cents: number | null | undefined): string {
  if (!isNum(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 1_000_000) return `${sign}$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 1 : 2)}M`;
  if (dollars >= 10_000) return `${sign}$${Math.round(dollars / 1000)}K`;
  return `${sign}$${Math.round(dollars).toLocaleString('en-US')}`;
}

export function fmtPct(fraction: number | null | undefined, digits = 0): string {
  return isNum(fraction) ? `${(fraction * 100).toFixed(digits)}%` : '—';
}

export const GRADE_LABELS: Record<Readiness['grade'], string> = {
  sale_ready: 'Sale-ready',
  nearly_ready: 'Nearly ready',
  needs_work: 'Needs work',
  early_stage: 'Early stage',
  unknown: 'Not enough data',
};

export function gradeFor(score: number | null): Readiness['grade'] {
  if (score === null) return 'unknown';
  if (score >= 80) return 'sale_ready';
  if (score >= 65) return 'nearly_ready';
  if (score >= 45) return 'needs_work';
  return 'early_stage';
}

// ============================================================
// EARNINGS + VALUATION
// ============================================================

export function validateMultiple(m: MultipleRange | null): string | null {
  if (m === null) return null;
  const vals = [m.low, m.mid, m.high];
  if (!vals.every((v) => isNum(v) && v > 0 && v <= 20)) return 'Multiples must be numbers between 0 and 20.';
  if (!(m.low <= m.mid && m.mid <= m.high)) return 'Use low ≤ mid ≤ high.';
  return null;
}

export function activeAddBacksTotal(addBacks: AddBack[]): number {
  return addBacks.filter((a) => a.active).reduce((sum, a) => sum + a.amountCents, 0);
}

export interface EarningsAdjust {
  /** Extra revenue growth, e.g. 0.1 = +10 %. Incremental earnings use the current positive margin. */
  revenueGrowth?: number;
  /** Percentage points of revenue added to earnings (margin improvement). */
  marginPoints?: number;
  ownerMarketSalaryCents?: number;
  extraAddBackCents?: number;
}

export function computeEarnings(input: ModelInput, adj: EarningsAdjust = {}): Earnings {
  const f = input.metrics.financials;
  const netIncome = f.revenueCents - f.expensesCents;
  const margin = f.revenueCents > 0 ? Math.max(netIncome, 0) / f.revenueCents : 0;
  const growthEarnings = Math.round(f.revenueCents * (adj.revenueGrowth ?? 0) * margin);
  const marginEarnings = Math.round(f.revenueCents * (1 + (adj.revenueGrowth ?? 0)) * ((adj.marginPoints ?? 0) / 100));
  const adjustedNet = netIncome + growthEarnings + marginEarnings;
  const auto = f.interestCents + f.taxCents + f.daCents;
  const manual = activeAddBacksTotal(input.addBacks) + (adj.extraAddBackCents ?? 0);
  const sde = adjustedNet + auto + manual;
  const salary = adj.ownerMarketSalaryCents ?? input.settings.ownerMarketSalaryCents;
  return {
    netIncomeCents: adjustedNet,
    autoAddBacksCents: auto,
    manualAddBacksCents: manual,
    sdeCents: sde,
    ownerSalaryCents: salary,
    ebitdaCents: sde - salary,
  };
}

export function resolveMultiples(settings: ExitSettings): { sde: MultipleRange; ebitda: MultipleRange } {
  const preset = INDUSTRY_PRESETS[settings.industryKey] ?? INDUSTRY_PRESETS.general_trades;
  return {
    sde: settings.sdeMultiple && !validateMultiple(settings.sdeMultiple) ? settings.sdeMultiple : preset.sde,
    ebitda: settings.ebitdaMultiple && !validateMultiple(settings.ebitdaMultiple) ? settings.ebitdaMultiple : preset.ebitda,
  };
}

export function pickMethod(settings: ExitSettings, earnings: Earnings): 'sde' | 'ebitda' {
  if (settings.method === 'sde' || settings.method === 'ebitda') return settings.method;
  return earnings.sdeCents < AUTO_METHOD_SDE_THRESHOLD_CENTS ? 'sde' : 'ebitda';
}

export function computeValuation(settings: ExitSettings, earnings: Earnings, readinessScore: number | null): Valuation {
  const method = pickMethod(settings, earnings);
  const multiples = resolveMultiples(settings);
  const multiple = method === 'sde' ? multiples.sde : multiples.ebitda;
  const base = method === 'sde' ? earnings.sdeCents : earnings.ebitdaCents;
  if (base <= 0) {
    return {
      method, earningsCents: base, multiple, pointMultiple: multiple.mid,
      lowCents: 0, midCents: 0, highCents: 0, pointCents: 0,
      reason: 'Earnings are zero or negative on the current inputs, so no value range can be estimated. Review add-backs and data.',
    };
  }
  const position = settings.readinessAdjusts && readinessScore !== null ? clamp(readinessScore / 100, 0, 1) : null;
  const pointMultiple = position === null ? multiple.mid : multiple.low + (multiple.high - multiple.low) * position;
  return {
    method,
    earningsCents: base,
    multiple,
    pointMultiple,
    lowCents: Math.round(base * multiple.low),
    midCents: Math.round(base * multiple.mid),
    highCents: Math.round(base * multiple.high),
    pointCents: Math.round(base * pointMultiple),
    reason: null,
  };
}

// ============================================================
// DRIVERS + READINESS SCORE
// ============================================================

export const DRIVER_WEIGHTS: Record<DriverKey, number> = {
  owner_dependence: 20,
  recurring_revenue: 15,
  customer_concentration: 12,
  workforce: 10,
  gross_margin: 10,
  documentation: 10,
  dso: 8,
  compliance: 8,
  data_quality: 7,
};

function statusFor(score: number | null): DriverStatus {
  if (score === null) return 'nodata';
  if (score >= 75) return 'strong';
  if (score >= 45) return 'ok';
  return 'weak';
}

function driver(key: DriverKey, label: string, score: number | null, display: string, detail: string): DriverResult {
  const s = score === null ? null : round1(clamp(score, 0, 100));
  return { key, label, weight: DRIVER_WEIGHTS[key], score: s, status: statusFor(s), display, detail };
}

export function scoreDrivers(m: ExitMetrics, ownerWeeklyHours: number | null, dataQuality: number | null): DriverResult[] {
  const out: DriverResult[] = [];

  // Recurring revenue — 0 % → 0, 25 %+ of revenue → 100.
  const rr = m.recurringShare;
  out.push(driver('recurring_revenue', 'Recurring revenue share', isNum(rr) ? lin(rr, 0, 0.25) : null,
    isNum(rr) ? `${fmtPct(rr, 1)} of revenue` : 'No data',
    'Annualised active membership revenue ÷ trailing-12-month revenue. Buyers pay more for revenue that renews.'));

  // Customer concentration — top customer ≥30 % → 0, ≤5 % → 100; top-5 ≥70 % → 0, ≤25 % → 100.
  const { top1, top5 } = m.concentration;
  let conc: number | null = null;
  if (isNum(top1) && isNum(top5)) conc = (lin(top1, 0.3, 0.05) + lin(top5, 0.7, 0.25)) / 2;
  else if (isNum(top1)) conc = lin(top1, 0.3, 0.05);
  out.push(driver('customer_concentration', 'Customer concentration', conc,
    isNum(top1) ? `Top customer ${fmtPct(top1, 1)} · top 5 ${fmtPct(top5, 1)}` : 'No data',
    'Share of trailing-12-month invoiced revenue from the largest customers. Heavy dependence on one account is a buyer risk.'));

  // Workforce — tenure 0 y → 0, 4 y+ → 100; turnover 40 % → 0, ≤10 % → 100.
  const w = m.workforce;
  const parts: number[] = [];
  if (isNum(w.avgTenureYears)) parts.push(lin(w.avgTenureYears, 0, 4));
  if (isNum(w.turnoverRate)) parts.push(lin(w.turnoverRate, 0.4, 0.1));
  out.push(driver('workforce', 'Technician tenure & turnover', w.headcount > 0 && parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null,
    w.headcount > 0
      ? `${isNum(w.avgTenureYears) ? w.avgTenureYears.toFixed(1) : '—'} yrs avg tenure · ${fmtPct(w.turnoverRate)} turnover`
      : 'No data',
    'Tenure is measured from the date each person was added to Vireek; turnover = people deactivated in the last 12 months ÷ (active + deactivated).'));

  // Owner dependence — revenue through owner/unassigned 80 % → 0, ≤10 % → 100; blended 70/30 with weekly hours (60 h → 0, ≤10 h → 100).
  const os = m.ownerDependence.revenueShare;
  let own: number | null = null;
  if (isNum(os)) {
    own = lin(os, 0.8, 0.1);
    if (isNum(ownerWeeklyHours)) own = own * 0.7 + lin(ownerWeeklyHours, 60, 10) * 0.3;
  } else if (isNum(ownerWeeklyHours)) {
    own = lin(ownerWeeklyHours, 60, 10);
  }
  out.push(driver('owner_dependence', 'Owner dependence', own,
    isNum(os) ? `${fmtPct(os)} of job revenue via owner / unassigned${isNum(ownerWeeklyHours) ? ` · ${ownerWeeklyHours} h/wk` : ''}` : 'No data',
    'Completed-job revenue (12 months) handled by the owner or with no technician assigned, optionally blended with the owner’s weekly operating hours.'));

  // DSO — 75 days → 0, ≤25 days → 100.
  out.push(driver('dso', 'Days sales outstanding', isNum(m.dso) ? lin(m.dso, 75, 25) : null,
    isNum(m.dso) ? `${Math.round(m.dso)} days` : 'No data',
    'Open receivables ÷ trailing-12-month invoiced revenue × 365. Slow collection ties up cash buyers must fund.'));

  // Gross margin — 20 % → 0, 50 %+ → 100.
  const gm = m.margin.overall;
  out.push(driver('gross_margin', 'Gross margin', isNum(gm) ? lin(gm, 0.2, 0.5) : null,
    isNum(gm) ? `${fmtPct(gm, 1)} (${fmtPct(m.margin.coveragePct)} of jobs costed)` : 'No data',
    'Completed jobs with cost entries, trailing 12 months. Per-service margins are shown below.'));

  // Documentation — 12 published SOPs → full, acknowledgement rate, 4+ categories.
  const d = m.documentation;
  const docScore = lin(d.published, 0, 12) * 0.6 + lin(d.ackRate ?? 0, 0, 1) * 0.25 + lin(d.categories, 0, 4) * 0.15;
  out.push(driver('documentation', 'Documentation & SOP completeness', docScore,
    `${d.published} published SOPs · ${d.categories} categories · ${isNum(d.ackRate) ? fmtPct(d.ackRate) : '—'} acknowledged`,
    'Published SOPs (target 12), spread over categories, acknowledged by the team on their current version.'));

  // License & insurance status.
  const c = m.compliance;
  const cp: number[] = [];
  if (c.credentialsTotal > 0) cp.push((c.credentialsValid / c.credentialsTotal) * 100);
  if (c.insuranceTotal > 0) cp.push(Math.min((c.insuranceValid / c.insuranceTotal) * 100, c.hasGeneralLiability ? 100 : 40));
  else if (c.credentialsTotal > 0) cp.push(0);
  out.push(driver('compliance', 'License & insurance status', cp.length ? cp.reduce((a, b) => a + b, 0) / cp.length : null,
    cp.length ? `${c.credentialsValid}/${c.credentialsTotal} licenses valid · ${c.insuranceValid}/${c.insuranceTotal} policies valid${c.hasGeneralLiability ? '' : ' · no active general liability'}` : 'No data',
    'Technician licences and insurance policies that are active and not expired. Missing general liability caps the insurance score.'));

  // Data quality — reuse the Data Quality Center score unchanged.
  out.push(driver('data_quality', 'Data quality', isNum(dataQuality) ? dataQuality : null,
    isNum(dataQuality) ? `${Math.round(dataQuality)} / 100` : 'No data',
    'Reused from the Data Quality Center. Buyers discount what they cannot verify.'));

  return out;
}

export function computeReadiness(drivers: DriverResult[]): Readiness {
  const total = drivers.reduce((s, d) => s + d.weight, 0);
  const scored = drivers.filter((d) => d.score !== null);
  const used = scored.reduce((s, d) => s + d.weight, 0);
  if (!scored.length || used === 0) return { score: null, coverage: 0, grade: 'unknown' };
  const score = round1(scored.reduce((s, d) => s + (d.score as number) * d.weight, 0) / used);
  return { score, coverage: total > 0 ? used / total : 0, grade: gradeFor(score) };
}

export function confidenceFor(readiness: Readiness, ledgerMonths: number): Confidence {
  if (readiness.coverage >= 0.85 && ledgerMonths >= 12) return 'high';
  if (readiness.coverage >= 0.6 && ledgerMonths >= 6) return 'medium';
  return 'low';
}

// ============================================================
// SCENARIOS (what-if simulator) + EVALUATION
// ============================================================

export interface Scenario {
  revenueGrowth?: number;
  marginPoints?: number;
  recurringShare?: number;
  top1?: number;
  top5?: number;
  ownerRevenueShare?: number;
  ownerWeeklyHours?: number;
  dso?: number;
  documentsPublished?: number;
  credentialsValidPct?: number;
  turnoverRate?: number;
  dataQuality?: number;
  ownerMarketSalaryCents?: number;
  extraAddBackCents?: number;
}

export function applyScenario(input: ModelInput, s: Scenario): { input: ModelInput; adjust: EarningsAdjust; ownerHours: number | null } {
  const m: ExitMetrics = JSON.parse(JSON.stringify(input.metrics)) as ExitMetrics;
  if (isNum(s.recurringShare)) m.recurringShare = clamp(s.recurringShare, 0, 1);
  if (isNum(s.top1)) m.concentration.top1 = clamp(s.top1, 0, 1);
  if (isNum(s.top5)) m.concentration.top5 = Math.max(clamp(s.top5, 0, 1), m.concentration.top1 ?? 0);
  if (isNum(s.ownerRevenueShare)) m.ownerDependence.revenueShare = clamp(s.ownerRevenueShare, 0, 1);
  if (isNum(s.dso)) m.dso = Math.max(0, s.dso);
  if (isNum(s.turnoverRate)) m.workforce.turnoverRate = clamp(s.turnoverRate, 0, 1);
  if (isNum(s.documentsPublished)) m.documentation.published = Math.max(0, Math.round(s.documentsPublished));
  if (isNum(s.credentialsValidPct) && m.compliance.credentialsTotal > 0) {
    m.compliance.credentialsValid = Math.round(clamp(s.credentialsValidPct, 0, 1) * m.compliance.credentialsTotal);
  }
  if (isNum(s.marginPoints) && isNum(m.margin.overall)) m.margin.overall = clamp(m.margin.overall + s.marginPoints / 100, 0, 1);
  return {
    input: { ...input, metrics: m, dataQuality: isNum(s.dataQuality) ? clamp(s.dataQuality, 0, 100) : input.dataQuality },
    adjust: {
      revenueGrowth: s.revenueGrowth,
      marginPoints: s.marginPoints,
      ownerMarketSalaryCents: s.ownerMarketSalaryCents,
      extraAddBackCents: s.extraAddBackCents,
    },
    ownerHours: isNum(s.ownerWeeklyHours) ? s.ownerWeeklyHours : input.settings.ownerWeeklyHours,
  };
}

export function evaluate(input: ModelInput, scenario: Scenario = {}): Evaluation {
  const applied = applyScenario(input, scenario);
  const drivers = scoreDrivers(applied.input.metrics, applied.ownerHours, applied.input.dataQuality);
  const readiness = computeReadiness(drivers);
  const earnings = computeEarnings(applied.input, applied.adjust);
  const valuation = computeValuation(input.settings, earnings, readiness.score);
  return { earnings, drivers, readiness, valuation, confidence: confidenceFor(readiness, input.metrics.ledgerMonths) };
}

// ============================================================
// ACTION PLAN
// ============================================================

export type ActionStatus = 'open' | 'in_progress' | 'done' | 'dismissed';
export type Effort = 'low' | 'medium' | 'high';

export interface ActionImpact {
  pointCents: number;
  lowCents: number;
  highCents: number;
}

export interface PlanAction {
  key: string;
  driver: DriverKey | 'addbacks';
  title: string;
  why: string;
  effort: Effort;
  horizonDays: number;
  /** null = real but not quantifiable with the model (shown as "not quantified"). */
  impact: ActionImpact | null;
  /** One-off cash released (not enterprise value), e.g. faster collection. */
  cashImpactCents: number | null;
  scenario: Scenario;
}

const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

export function buildActionPlan(input: ModelInput): PlanAction[] {
  const m = input.metrics;
  const base = evaluate(input);
  const candidates: Omit<PlanAction, 'impact' | 'cashImpactCents'>[] = [];
  const get = (k: DriverKey) => base.drivers.find((d) => d.key === k);
  const weak = (k: DriverKey) => {
    const d = get(k);
    return d !== undefined && d.score !== null && d.score < 75;
  };

  if (weak('recurring_revenue') && isNum(m.recurringShare)) {
    const target = Math.min(m.recurringShare + 0.1, 0.25);
    candidates.push({
      key: 'grow_memberships', driver: 'recurring_revenue',
      title: `Raise recurring revenue to ${fmtPct(target)} of revenue`,
      why: 'Enrol more completed-job customers in maintenance memberships and turn on auto-renew.',
      effort: 'medium', horizonDays: 180, scenario: { recurringShare: target },
    });
  }
  if (weak('customer_concentration') && isNum(m.concentration.top1)) {
    const t1 = Math.min(m.concentration.top1, 0.1);
    candidates.push({
      key: 'reduce_concentration', driver: 'customer_concentration',
      title: `Bring your largest customer under ${fmtPct(Math.max(t1, 0.1))} of revenue`,
      why: 'Grow other accounts and add commercial contracts so no single customer can move the business.',
      effort: 'high', horizonDays: 365,
      scenario: { top1: Math.min(m.concentration.top1, 0.1), top5: Math.min(m.concentration.top5 ?? 0.4, 0.4) },
    });
  }
  if (weak('owner_dependence') && isNum(m.ownerDependence.revenueShare)) {
    const target = Math.max(0.1, m.ownerDependence.revenueShare - 0.25);
    candidates.push({
      key: 'delegate_owner_revenue', driver: 'owner_dependence',
      title: `Move owner-handled revenue down to ${fmtPct(target)}`,
      why: 'Assign every job to a technician, hand estimating and key accounts to a lead, and document how you decide.',
      effort: 'high', horizonDays: 270, scenario: isNum(input.settings.ownerWeeklyHours)
        ? { ownerRevenueShare: target, ownerWeeklyHours: Math.min(input.settings.ownerWeeklyHours, 35) }
        : { ownerRevenueShare: target },
    });
  }
  if (weak('dso') && isNum(m.dso)) {
    const target = Math.max(30, m.dso - 15);
    candidates.push({
      key: 'cut_dso', driver: 'dso',
      title: `Cut days sales outstanding to ${Math.round(target)}`,
      why: 'Collect at job completion, enable pay-by-link and automatic reminders, and escalate 30+ day balances.',
      effort: 'low', horizonDays: 90, scenario: { dso: target },
    });
  }
  if (weak('gross_margin') && isNum(m.margin.overall)) {
    candidates.push({
      key: 'lift_margin', driver: 'gross_margin',
      title: 'Lift gross margin by 3 points',
      why: 'Raise prices on your lowest-margin services (see the service table) and fix under-priced job types.',
      effort: 'medium', horizonDays: 120, scenario: { marginPoints: 3 },
    });
  }
  if (weak('workforce')) {
    candidates.push({
      key: 'retain_techs', driver: 'workforce',
      title: 'Reduce technician turnover to 15%',
      why: 'Career ladders, training and fair pay make a team a transferable asset.',
      effort: 'high', horizonDays: 365, scenario: { turnoverRate: 0.15 },
    });
  }
  if (weak('documentation')) {
    candidates.push({
      key: 'publish_sops', driver: 'documentation',
      title: `Publish ${Math.max(12, m.documentation.published)} SOPs and collect acknowledgements`,
      why: 'Write down dispatch, estimating, install, safety and billing procedures so the business runs without you.',
      effort: 'medium', horizonDays: 120, scenario: { documentsPublished: Math.max(12, m.documentation.published) },
    });
  }
  if (weak('compliance')) {
    candidates.push({
      key: 'fix_compliance', driver: 'compliance',
      title: 'Renew expiring licences and insurance',
      why: 'Every technician licence and policy should be current, and an active general liability policy must be on file.',
      effort: 'low', horizonDays: 45, scenario: { credentialsValidPct: 1 },
    });
  }
  if (weak('data_quality')) {
    candidates.push({
      key: 'fix_data_quality', driver: 'data_quality',
      title: 'Raise data quality to 90+',
      why: 'Work through the Data Quality Center fixes so buyers can verify customers, equipment and job costs.',
      effort: 'low', horizonDays: 60, scenario: { dataQuality: 90 },
    });
  }
  const hasOwnerAddBack = input.addBacks.some((a) => a.active && a.kind === 'owner_compensation');
  if (!hasOwnerAddBack) {
    candidates.push({
      key: 'document_owner_comp', driver: 'addbacks',
      title: 'Record your owner compensation add-back',
      why: 'Without a documented owner-pay add-back, SDE is likely understated. Add it with a justification and evidence.',
      effort: 'low', horizonDays: 14, scenario: {},
    });
  }

  const actions: PlanAction[] = candidates.map((c) => {
    const quantifiable = Object.keys(c.scenario).length > 0;
    let impact: ActionImpact | null = null;
    if (quantifiable && base.valuation.reason === null) {
      const next = evaluate(input, c.scenario);
      impact = {
        pointCents: next.valuation.pointCents - base.valuation.pointCents,
        lowCents: next.valuation.lowCents - base.valuation.lowCents,
        highCents: next.valuation.highCents - base.valuation.highCents,
      };
    }
    const cash =
      c.key === 'cut_dso' && isNum(m.dso) && isNum(c.scenario.dso)
        ? Math.round(((m.dso - c.scenario.dso) / 365) * m.financials.revenueCents)
        : null;
    return { ...c, impact, cashImpactCents: cash };
  });

  return actions.sort((a, b) => {
    const ai = a.impact?.pointCents ?? Number.NEGATIVE_INFINITY;
    const bi = b.impact?.pointCents ?? Number.NEGATIVE_INFINITY;
    if (ai !== bi) return bi - ai;
    return EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort];
  });
}

// ============================================================
// TRENDS + VALIDATION
// ============================================================

export interface SnapshotLite {
  periodMonth: string;
  readinessScore: number | null;
  driverScores: Partial<Record<DriverKey, number | null>>;
  valuePointCents: number | null;
}

export type Trend = { direction: 'up' | 'down' | 'flat' | 'none'; delta: number | null };

/** Compare the current score with the most recent snapshot from an earlier month. */
export function trendFor(current: number | null, previous: number | null | undefined): Trend {
  if (current === null || previous === null || previous === undefined) return { direction: 'none', delta: null };
  const delta = round1(current - previous);
  if (Math.abs(delta) < 2) return { direction: 'flat', delta };
  return { direction: delta > 0 ? 'up' : 'down', delta };
}

export function previousSnapshot(snapshots: SnapshotLite[], now = new Date()): SnapshotLite | null {
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const earlier = snapshots.filter((s) => s.periodMonth < thisMonth).sort((a, b) => (a.periodMonth < b.periodMonth ? 1 : -1));
  return earlier[0] ?? null;
}

export interface AddBackDraft {
  kind: AddBackKind;
  label: string;
  /** Positive number entered by the user, in dollars. */
  amountDollars: string;
  justification: string;
  evidenceRef: string;
}

export function validateAddBack(d: AddBackDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.label.trim().length < 2 || d.label.trim().length > 120) e.label = 'Enter a label (2–120 characters).';
  const n = Number(d.amountDollars);
  if (!d.amountDollars.trim() || !Number.isFinite(n) || n <= 0 || n > 10_000_000_000) e.amountDollars = 'Enter an amount greater than zero.';
  const j = d.justification.trim().length;
  if (j < 10 || j > 1000) e.justification = 'Explain why this adjustment is valid (10–1000 characters). Buyers will ask.';
  if (d.evidenceRef.trim().length > 300) e.evidenceRef = 'Keep the evidence reference under 300 characters.';
  return e;
}

/** Add-backs are stored positive; a `deduction` is stored negative (matches the DB constraint). */
export function signedAmountCents(kind: AddBackKind, amountDollars: string): number {
  const cents = Math.round(Number(amountDollars) * 100);
  return kind === 'deduction' ? -Math.abs(cents) : Math.abs(cents);
}

export interface ShareDraft {
  label: string;
  recipient: string;
  expiresHours: number;
  maxViews: number;
  sections: string[];
}

export const DATA_ROOM_SECTIONS = [
  { key: 'financials', label: 'Financial summaries', hint: 'TTM P&L totals, monthly revenue/expenses, balance sheet and receivables aging.' },
  { key: 'kpis', label: 'KPI history', hint: 'Current value drivers and monthly snapshots (no customer names).' },
  { key: 'contracts', label: 'Contracts', hint: 'Commercial contract terms and values; customer names are left out.' },
  { key: 'equipment', label: 'Equipment', hint: 'Installed-base counts and warranty status by type; no customer details.' },
  { key: 'credentials', label: 'Licences, insurance & credentials', hint: 'Licence and policy types and expiry; staff are pseudonymised unless you opt in.' },
  { key: 'valuation', label: 'Your estimate summary', hint: 'The estimate you see on screen, clearly labelled as an estimate.' },
] as const;

export function validateShare(d: ShareDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.label.trim().length < 2 || d.label.trim().length > 120) e.label = 'Name this data room (2–120 characters).';
  if (d.recipient.trim().length > 120) e.recipient = 'Keep the recipient under 120 characters.';
  if (!Number.isInteger(d.expiresHours) || d.expiresHours < 1 || d.expiresHours > 720) e.expiresHours = 'Choose 1 hour to 30 days.';
  if (!Number.isInteger(d.maxViews) || d.maxViews < 1 || d.maxViews > 1000) e.maxViews = 'Choose 1 to 1000 views.';
  const allowed = new Set<string>(DATA_ROOM_SECTIONS.map((s) => s.key));
  if (!d.sections.length || d.sections.some((s) => !allowed.has(s))) e.sections = 'Select at least one section to share.';
  return e;
}

export type LinkState = 'active' | 'expired' | 'revoked' | 'exhausted';

export function linkState(
  l: { expiresAt: string; revokedAt: string | null; viewCount: number; maxViews: number },
  now = new Date(),
): LinkState {
  if (l.revokedAt) return 'revoked';
  if (new Date(l.expiresAt).getTime() <= now.getTime()) return 'expired';
  if (l.viewCount >= l.maxViews) return 'exhausted';
  return 'active';
}

// ============================================================
// SHAREABLE ESTIMATE SUMMARY (goes into the data room "valuation" section)
// ============================================================

export function buildValuationSummary(input: ModelInput, ev: Evaluation): Record<string, unknown> {
  const mult = ev.valuation.multiple;
  return {
    label: 'ESTIMATE — not a valuation',
    disclaimer: ESTIMATE_DISCLAIMER,
    method: ev.valuation.method === 'sde' ? 'Seller’s discretionary earnings (SDE)' : 'Adjusted EBITDA',
    earningsCents: ev.valuation.earningsCents,
    multipleRange: { low: mult.low, mid: mult.mid, high: mult.high },
    estimateRangeCents: { low: ev.valuation.lowCents, mid: ev.valuation.midCents, high: ev.valuation.highCents },
    readinessAdjustedPointCents: ev.valuation.pointCents,
    confidence: ev.confidence,
    sellReadinessScore: ev.readiness.score,
    sellReadinessGrade: GRADE_LABELS[ev.readiness.grade],
    earningsBridge: {
      netIncomeCents: ev.earnings.netIncomeCents,
      ledgerAddBacksCents: ev.earnings.autoAddBacksCents,
      documentedAddBacksCents: ev.earnings.manualAddBacksCents,
      sdeCents: ev.earnings.sdeCents,
      ownerReplacementSalaryCents: ev.earnings.ownerSalaryCents,
      adjustedEbitdaCents: ev.earnings.ebitdaCents,
    },
    documentedAddBacks: input.addBacks
      .filter((a) => a.active)
      .map((a) => ({ type: ADDBACK_KIND_LABELS[a.kind], label: a.label, amountCents: a.amountCents, justification: a.justification, evidence: a.evidenceRef })),
    drivers: ev.drivers.map((d) => ({ driver: d.label, score: d.score, current: d.display })),
  };
}
