import { supabase } from '@/lib/supabase';

// ============================================================
// Types
// ============================================================

export type DimensionKey = 'financial' | 'owner' | 'customers' | 'operations' | 'legal' | 'growth';
export type AnswerValue = 0 | 1 | 2 | 3;
export type Answers = Record<string, AnswerValue>;
export type DataRoomStatus = 'not_started' | 'in_progress' | 'ready' | 'not_applicable';
export type DataRoomCategory = 'financial' | 'tax' | 'legal' | 'customers' | 'operations' | 'people' | 'assets';
export type ReadinessBand = 'not_ready' | 'early' | 'nearly' | 'ready';
export type Confidence = 'low' | 'medium' | 'high';

export interface ValuationProfile {
  id: string;
  annual_revenue: number | null;
  owner_earnings: number | null;
  revenue_growth_pct: number | null;
  recurring_revenue_pct: number | null;
  top_customer_pct: number | null;
  cash_on_hand: number | null;
  total_debt: number | null;
  multiple_low: number;
  multiple_high: number;
  answers: Answers;
  target_exit_date: string | null;
  updated_at: string;
}

export interface DataRoomRow {
  item_key: string;
  status: DataRoomStatus;
  note: string | null;
  updated_at: string;
}

export interface ValuationSnapshot {
  id: string;
  label: string | null;
  readiness_score: number | null;
  assessment_score: number | null;
  data_room_score: number | null;
  value_low: number | null;
  value_mid: number | null;
  value_high: number | null;
  owner_earnings: number | null;
  multiple_mid: number | null;
  dimension_scores: Record<string, number>;
  created_at: string;
}

export interface ValuationBundle {
  profile: ValuationProfile | null;
  items: DataRoomRow[];
  snapshots: ValuationSnapshot[];
}

// ============================================================
// Catalogs
// ============================================================

export const DEFAULT_MULTIPLE_LOW = 2;
export const DEFAULT_MULTIPLE_HIGH = 3.5;
export const ASSESSMENT_WEIGHT = 0.65;
export const DATA_ROOM_WEIGHT = 0.35;
export const TARGET_READINESS = 80;
export const SNAPSHOT_LIMIT = 24;

export const DIMENSIONS: ReadonlyArray<{ key: DimensionKey; label: string; blurb: string; weight: number }> = [
  { key: 'financial', label: 'Financial quality', blurb: 'Clean books a buyer can trust.', weight: 0.22 },
  { key: 'owner', label: 'Owner independence', blurb: 'Value that survives the owner leaving.', weight: 0.2 },
  { key: 'customers', label: 'Customer durability', blurb: 'Recurring, diversified, loyal revenue.', weight: 0.18 },
  { key: 'operations', label: 'Operations and team', blurb: 'Documented systems and a stable crew.', weight: 0.15 },
  { key: 'legal', label: 'Legal and compliance', blurb: 'Nothing that scares a buyer’s lawyer.', weight: 0.13 },
  { key: 'growth', label: 'Growth story', blurb: 'A credible reason to pay for the future.', weight: 0.12 },
];

export interface Question {
  key: string;
  dimension: DimensionKey;
  prompt: string;
  action: string;
}

export const ANSWER_LABELS: ReadonlyArray<{ value: AnswerValue; label: string }> = [
  { value: 0, label: 'Not at all' },
  { value: 1, label: 'Partly' },
  { value: 2, label: 'Mostly' },
  { value: 3, label: 'Fully' },
];

export const QUESTIONS: ReadonlyArray<Question> = [
  { key: 'fin_books', dimension: 'financial', prompt: 'Books are closed and reviewed within 15 days of month-end.', action: 'Close the books monthly and keep 36 months of statements ready.' },
  { key: 'fin_addbacks', dimension: 'financial', prompt: 'Owner pay, personal expenses and one-time costs are documented as clean add-backs.', action: 'Document every add-back with proof so earnings hold up in diligence.' },
  { key: 'fin_margin', dimension: 'financial', prompt: 'Job costing shows margin by service line, and margins are stable or improving.', action: 'Track gross margin by service line and fix the weakest lines.' },
  { key: 'own_field', dimension: 'owner', prompt: 'The business runs without the owner on service calls or in the field.', action: 'Move the owner out of daily field work and sales calls.' },
  { key: 'own_manager', dimension: 'owner', prompt: 'A manager or operations lead can run a normal week without the owner.', action: 'Name an operations lead who can run a full week without you.' },
  { key: 'own_relationships', dimension: 'owner', prompt: 'Key customer, supplier and technician relationships are held by the team, not only the owner.', action: 'Introduce the team to key accounts and suppliers so relationships transfer.' },
  { key: 'cus_recurring', dimension: 'customers', prompt: 'A meaningful share of revenue is recurring (maintenance plans, memberships, contracts).', action: 'Grow maintenance plans and memberships; buyers pay more for recurring revenue.' },
  { key: 'cus_concentration', dimension: 'customers', prompt: 'No single customer, builder or referral source is more than 10% of revenue.', action: 'Reduce dependence on any one customer or referral source.' },
  { key: 'cus_retention', dimension: 'customers', prompt: 'Repeat and renewal rates are tracked and healthy.', action: 'Track repeat and renewal rates monthly and report them.' },
  { key: 'ops_sops', dimension: 'operations', prompt: 'Core processes are written down as SOPs and followed by the team.', action: 'Write the SOPs for dispatch, estimating, install and billing.' },
  { key: 'ops_team', dimension: 'operations', prompt: 'Technician turnover is low and every key role has a backup.', action: 'Lower turnover and cross-train a backup for each key role.' },
  { key: 'ops_systems', dimension: 'operations', prompt: 'Scheduling, dispatch, invoicing and customer data live in one system, not in people’s heads.', action: 'Move all job and customer data into one system of record.' },
  { key: 'leg_licenses', dimension: 'legal', prompt: 'Licenses, insurance and permits are current and can be transferred or re-issued to a buyer.', action: 'Confirm every license and policy is current and transferable.' },
  { key: 'leg_contracts', dimension: 'legal', prompt: 'Customer, vendor, vehicle and lease contracts are organised, signed and assignable.', action: 'Collect signed contracts and check assignment clauses.' },
  { key: 'leg_clean', dimension: 'legal', prompt: 'There are no open disputes, liens, unresolved claims or tax issues.', action: 'Resolve open disputes, liens and tax issues before going to market.' },
  { key: 'gro_trend', dimension: 'growth', prompt: 'Revenue has grown or held steady for the last three years.', action: 'Stabilise revenue and be ready to explain any dip.' },
  { key: 'gro_pipeline', dimension: 'growth', prompt: 'Leads come from a marketing engine or backlog that does not depend on the owner’s network.', action: 'Build a lead source that works without the owner’s personal network.' },
  { key: 'gro_story', dimension: 'growth', prompt: 'A written growth plan (territories, services, hires) exists for a new owner.', action: 'Write a one-page growth plan a new owner could execute.' },
];

export interface DataRoomItemDef {
  key: string;
  category: DataRoomCategory;
  title: string;
  hint: string;
  weight: 1 | 2 | 3;
}

export const DATA_ROOM_CATEGORIES: ReadonlyArray<{ key: DataRoomCategory; label: string }> = [
  { key: 'financial', label: 'Financial' },
  { key: 'tax', label: 'Tax' },
  { key: 'legal', label: 'Legal and compliance' },
  { key: 'customers', label: 'Customers and sales' },
  { key: 'operations', label: 'Operations' },
  { key: 'people', label: 'People' },
  { key: 'assets', label: 'Assets and leases' },
];

export const DATA_ROOM_ITEMS: ReadonlyArray<DataRoomItemDef> = [
  { key: 'fin_pl_3y', category: 'financial', title: 'Profit and loss statements, last 3 years', hint: 'Year-end and trailing 12 months.', weight: 3 },
  { key: 'fin_bs_3y', category: 'financial', title: 'Balance sheets, last 3 years', hint: 'Year-end balance sheets.', weight: 3 },
  { key: 'fin_monthly_ytd', category: 'financial', title: 'Monthly financials, year to date', hint: 'Current-year monthly P&L.', weight: 2 },
  { key: 'fin_addbacks', category: 'financial', title: 'Owner add-backs schedule with support', hint: 'Each add-back with a receipt or statement.', weight: 3 },
  { key: 'fin_ar_ap', category: 'financial', title: 'A/R and A/P aging reports', hint: 'Dated within the last 30 days.', weight: 2 },
  { key: 'fin_debt', category: 'financial', title: 'Debt, loan and lease schedule', hint: 'Lender, balance, rate, maturity.', weight: 2 },
  { key: 'fin_bank', category: 'financial', title: 'Bank and merchant statements, last 12 months', hint: 'Business accounts and card processors.', weight: 1 },
  { key: 'tax_returns_3y', category: 'tax', title: 'Business tax returns, last 3 years', hint: 'Filed returns with schedules.', weight: 3 },
  { key: 'tax_filings', category: 'tax', title: 'Sales and payroll tax filings', hint: 'Recent filings and any clearance letters.', weight: 2 },
  { key: 'leg_entity', category: 'legal', title: 'Entity documents and ownership', hint: 'Formation papers, operating agreement, cap table.', weight: 3 },
  { key: 'leg_licenses', category: 'legal', title: 'Licenses and certifications', hint: 'Trade, contractor, EPA and local permits.', weight: 3 },
  { key: 'leg_insurance', category: 'legal', title: 'Insurance policies and loss runs', hint: 'Current policies and 5-year loss history.', weight: 2 },
  { key: 'leg_disputes', category: 'legal', title: 'Litigation, claims and dispute summary', hint: 'Open and closed matters, or a written “none”.', weight: 2 },
  { key: 'leg_brand', category: 'legal', title: 'Brand, domain and phone number ownership', hint: 'Proof the company, not a person, owns them.', weight: 1 },
  { key: 'cus_top20', category: 'customers', title: 'Top 20 customers by revenue, 3 years', hint: 'Revenue per customer per year.', weight: 3 },
  { key: 'cus_plans', category: 'customers', title: 'Maintenance plan roster and renewal rates', hint: 'Active members, price, renewal history.', weight: 3 },
  { key: 'cus_contracts', category: 'customers', title: 'Commercial and builder contracts', hint: 'Signed agreements with terms.', weight: 2 },
  { key: 'cus_leads', category: 'customers', title: 'Lead sources and marketing spend by channel', hint: 'Cost per lead and per booked job.', weight: 2 },
  { key: 'cus_reviews', category: 'customers', title: 'Reviews and reputation summary', hint: 'Ratings and counts by platform.', weight: 1 },
  { key: 'ops_jobs', category: 'operations', title: 'Job history: revenue and margin by service line', hint: 'Export 3 years of completed jobs.', weight: 3 },
  { key: 'ops_sops', category: 'operations', title: 'SOP library and training materials', hint: 'Documented processes and onboarding.', weight: 2 },
  { key: 'ops_pricing', category: 'operations', title: 'Price book and pricing policy', hint: 'Current prices and discount rules.', weight: 1 },
  { key: 'ops_vendors', category: 'operations', title: 'Key vendor and supplier agreements', hint: 'Terms, rebates, exclusivity.', weight: 1 },
  { key: 'ppl_roster', category: 'people', title: 'Employee roster with pay, tenure and certifications', hint: 'One row per person.', weight: 3 },
  { key: 'ppl_org', category: 'people', title: 'Org chart and role descriptions', hint: 'Who reports to whom.', weight: 2 },
  { key: 'ppl_agreements', category: 'people', title: 'Employment, non-compete and contractor agreements', hint: 'Signed copies.', weight: 2 },
  { key: 'ppl_benefits', category: 'people', title: 'Benefits, PTO and payroll liabilities', hint: 'Accrued PTO and benefit costs.', weight: 1 },
  { key: 'ast_vehicles', category: 'assets', title: 'Vehicle and fleet list with titles and loans', hint: 'VIN, owner of record, lien holder.', weight: 2 },
  { key: 'ast_leases', category: 'assets', title: 'Real estate leases and landlord consent', hint: 'Terms and assignment rights.', weight: 2 },
  { key: 'ast_equipment', category: 'assets', title: 'Equipment and tool inventory', hint: 'Major equipment with age and condition.', weight: 1 },
  { key: 'ast_inventory', category: 'assets', title: 'Parts inventory and valuation', hint: 'Count and cost on a stated date.', weight: 1 },
];

export const DATA_ROOM_STATUSES: ReadonlyArray<{ key: DataRoomStatus; label: string }> = [
  { key: 'not_started', label: 'Not started' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'ready', label: 'Ready' },
  { key: 'not_applicable', label: 'Not applicable' },
];

export const DATA_ROOM_NOTE_MAX = 500;
const STATUS_CREDIT: Record<DataRoomStatus, number> = { not_started: 0, in_progress: 0.4, ready: 1, not_applicable: 0 };

// ============================================================
// Pure helpers
// ============================================================

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const clamp01 = (n: number) => clamp(n, 0, 1);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function formatMoney(amount: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
    ...(opts.compact && Math.abs(amount) >= 1_000_000 ? { notation: 'compact' as const, maximumFractionDigits: 2 } : {}),
  }).format(amount);
}

export function readinessBand(score: number | null): ReadinessBand | null {
  if (score == null) return null;
  if (score >= 80) return 'ready';
  if (score >= 60) return 'nearly';
  if (score >= 40) return 'early';
  return 'not_ready';
}

export const BAND_LABEL: Record<ReadinessBand, string> = {
  not_ready: 'Not ready',
  early: 'Early stage',
  nearly: 'Nearly ready',
  ready: 'Exit-ready',
};

/** Keeps only valid answers for known questions. Anything else is dropped. */
export function sanitizeAnswers(raw: unknown): Answers {
  const out: Answers = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const q of QUESTIONS) {
    const v = src[q.key];
    if (v === 0 || v === 1 || v === 2 || v === 3) out[q.key] = v;
  }
  return out;
}

export interface AssessmentResult {
  /** 0–100, or null while nothing has been answered. */
  score: number | null;
  answered: number;
  total: number;
  dimensions: Array<{ key: DimensionKey; label: string; score: number | null; answered: number; total: number }>;
}

export function scoreAssessment(answers: Answers): AssessmentResult {
  const clean = sanitizeAnswers(answers);
  let weighted = 0;
  let answered = 0;
  const dimensions = DIMENSIONS.map((d) => {
    const qs = QUESTIONS.filter((q) => q.dimension === d.key);
    const given = qs.filter((q) => clean[q.key] !== undefined);
    const sum = given.reduce((s, q) => s + (clean[q.key] ?? 0), 0);
    // Unanswered questions count as 0, so a partly-filled survey never looks better than it is.
    const score = given.length === 0 ? null : Math.round((sum / (qs.length * 3)) * 100);
    weighted += (sum / (qs.length * 3)) * d.weight;
    answered += given.length;
    return { key: d.key, label: d.label, score, answered: given.length, total: qs.length };
  });
  return { score: answered === 0 ? null : Math.round(weighted * 100), answered, total: QUESTIONS.length, dimensions };
}

export interface DataRoomResult {
  /** 0–100 weighted completion of applicable items. */
  score: number;
  ready: number;
  inProgress: number;
  notStarted: number;
  notApplicable: number;
  total: number;
}

export function indexItems(rows: DataRoomRow[]): Record<string, DataRoomRow> {
  const map: Record<string, DataRoomRow> = {};
  for (const r of rows) map[r.item_key] = r;
  return map;
}

export function scoreDataRoom(rows: DataRoomRow[]): DataRoomResult {
  const byKey = indexItems(rows);
  let earned = 0;
  let possible = 0;
  const counts = { ready: 0, inProgress: 0, notStarted: 0, notApplicable: 0 };
  for (const item of DATA_ROOM_ITEMS) {
    const status = byKey[item.key]?.status ?? 'not_started';
    if (status === 'not_applicable') { counts.notApplicable += 1; continue; }
    possible += item.weight;
    earned += item.weight * STATUS_CREDIT[status];
    if (status === 'ready') counts.ready += 1;
    else if (status === 'in_progress') counts.inProgress += 1;
    else counts.notStarted += 1;
  }
  return { score: possible === 0 ? 0 : Math.round((earned / possible) * 100), ...counts, total: DATA_ROOM_ITEMS.length };
}

/** Overall readiness blends the questionnaire (65%) and the data room (35%). Null until the questionnaire has an answer. */
export function overallReadiness(assessment: AssessmentResult, dataRoom: DataRoomResult): number | null {
  if (assessment.score == null) return null;
  return Math.round(assessment.score * ASSESSMENT_WEIGHT + dataRoom.score * DATA_ROOM_WEIGHT);
}

// ---------- Valuation ----------

export interface ValuationInputs {
  annual_revenue: number | null;
  owner_earnings: number | null;
  revenue_growth_pct: number | null;
  recurring_revenue_pct: number | null;
  top_customer_pct: number | null;
  cash_on_hand: number | null;
  total_debt: number | null;
  multiple_low: number;
  multiple_high: number;
}

export interface ValuationEstimate {
  canCompute: boolean;
  reason: string | null;
  position: number;
  multipleLow: number;
  multipleMid: number;
  multipleHigh: number;
  valueLow: number;
  valueMid: number;
  valueHigh: number;
  equityMid: number;
  debtExceedsValue: boolean;
  impliedRevenueMultiple: number | null;
  readinessUplift: number;
  confidence: Confidence;
}

const EMPTY_ESTIMATE: ValuationEstimate = {
  canCompute: false, reason: null, position: 0, multipleLow: 0, multipleMid: 0, multipleHigh: 0,
  valueLow: 0, valueMid: 0, valueHigh: 0, equityMid: 0, debtExceedsValue: false,
  impliedRevenueMultiple: null, readinessUplift: 0, confidence: 'low',
};

/**
 * Indicative enterprise value = owner earnings (SDE) x a multiple. The multiple sits inside the
 * band the owner chose; where it lands depends on readiness, recurring revenue, customer
 * concentration and growth. This is a planning estimate, not an appraisal.
 */
export function estimateValue(inputs: ValuationInputs, readiness: number | null, answeredQuestions = 0): ValuationEstimate {
  const earnings = inputs.owner_earnings;
  if (earnings == null || !Number.isFinite(earnings)) return { ...EMPTY_ESTIMATE, reason: 'Enter your annual owner earnings to see an estimate.' };
  if (earnings <= 0) return { ...EMPTY_ESTIMATE, reason: 'Owner earnings must be above zero for an earnings-based estimate.' };
  const low = inputs.multiple_low;
  const high = inputs.multiple_high;
  if (!(low > 0) || !(high > low)) return { ...EMPTY_ESTIMATE, reason: 'The high multiple must be greater than the low multiple.' };

  const factors = (r: number | null) => {
    const recurring = inputs.recurring_revenue_pct == null ? 0.5 : clamp01(inputs.recurring_revenue_pct / 40);
    const concentration = inputs.top_customer_pct == null ? 0.5 : 1 - clamp01((inputs.top_customer_pct - 5) / 25);
    const growth = inputs.revenue_growth_pct == null ? 0.5 : clamp01((inputs.revenue_growth_pct + 5) / 20);
    const ready = r == null ? 0.5 : clamp01(r / 100);
    return clamp01(0.45 * ready + 0.2 * recurring + 0.2 * concentration + 0.15 * growth);
  };
  const multipleAt = (p: number) => low + p * (high - low);

  const position = factors(readiness);
  const pLow = Math.max(0, position - 0.15);
  const pHigh = Math.min(1, position + 0.15);
  const valueLow = earnings * multipleAt(pLow);
  const valueMid = earnings * multipleAt(position);
  const valueHigh = earnings * multipleAt(pHigh);
  const net = valueMid + (inputs.cash_on_hand ?? 0) - (inputs.total_debt ?? 0);

  const uplift = readiness != null && readiness < TARGET_READINESS
    ? Math.max(0, earnings * (multipleAt(factors(TARGET_READINESS)) - multipleAt(position)))
    : 0;

  const optional = [inputs.recurring_revenue_pct, inputs.top_customer_pct, inputs.revenue_growth_pct].filter((v) => v != null).length;
  const share = answeredQuestions / QUESTIONS.length;
  const confidence: Confidence = share >= 0.9 && optional === 3 ? 'high' : share >= 0.5 && optional >= 2 ? 'medium' : 'low';

  return {
    canCompute: true,
    reason: null,
    position,
    multipleLow: round2(multipleAt(pLow)),
    multipleMid: round2(multipleAt(position)),
    multipleHigh: round2(multipleAt(pHigh)),
    valueLow: Math.round(valueLow),
    valueMid: Math.round(valueMid),
    valueHigh: Math.round(valueHigh),
    equityMid: Math.round(Math.max(0, net)),
    debtExceedsValue: net < 0,
    impliedRevenueMultiple: inputs.annual_revenue && inputs.annual_revenue > 0 ? round2(valueMid / inputs.annual_revenue) : null,
    readinessUplift: Math.round(uplift),
    confidence,
  };
}

// ---------- Recommendations ----------

export interface Recommendation {
  id: string;
  kind: 'assessment' | 'data_room';
  title: string;
  detail: string;
  /** Approximate readiness points (0–100) gained by finishing this. */
  impact: number;
}

export function buildRecommendations(answers: Answers, rows: DataRoomRow[], limit = 5): Recommendation[] {
  const clean = sanitizeAnswers(answers);
  const byKey = indexItems(rows);
  const out: Recommendation[] = [];

  for (const q of QUESTIONS) {
    const dim = DIMENSIONS.find((d) => d.key === q.dimension);
    if (!dim) continue;
    const perDim = QUESTIONS.filter((x) => x.dimension === q.dimension).length;
    const answer = clean[q.key];
    const gap = answer === undefined ? 0 : (3 - answer) / 3;
    if (gap <= 0) continue;
    out.push({
      id: `q:${q.key}`,
      kind: 'assessment',
      title: q.action,
      detail: `${dim.label}: you rated this “${ANSWER_LABELS[answer ?? 0].label.toLowerCase()}”.`,
      impact: round2(gap * (dim.weight / perDim) * ASSESSMENT_WEIGHT * 100),
    });
  }

  const possible = DATA_ROOM_ITEMS.reduce((s, i) => s + (byKey[i.key]?.status === 'not_applicable' ? 0 : i.weight), 0);
  for (const item of DATA_ROOM_ITEMS) {
    const status = byKey[item.key]?.status ?? 'not_started';
    if (status === 'ready' || status === 'not_applicable' || possible === 0) continue;
    out.push({
      id: `d:${item.key}`,
      kind: 'data_room',
      title: `Gather: ${item.title}`,
      detail: status === 'in_progress' ? 'Started but not finished.' : item.hint,
      impact: round2(((1 - STATUS_CREDIT[status]) * item.weight / possible) * DATA_ROOM_WEIGHT * 100),
    });
  }

  return out.sort((a, b) => b.impact - a.impact || a.title.localeCompare(b.title)).slice(0, limit);
}

// ============================================================
// Form helpers
// ============================================================

export interface NumbersForm {
  annual_revenue: string;
  owner_earnings: string;
  revenue_growth_pct: string;
  recurring_revenue_pct: string;
  top_customer_pct: string;
  cash_on_hand: string;
  total_debt: string;
  multiple_low: string;
  multiple_high: string;
  target_exit_date: string;
}

export type NumbersErrors = Partial<Record<keyof NumbersForm, string>>;

export function emptyNumbersForm(): NumbersForm {
  return {
    annual_revenue: '', owner_earnings: '', revenue_growth_pct: '', recurring_revenue_pct: '', top_customer_pct: '',
    cash_on_hand: '', total_debt: '', multiple_low: String(DEFAULT_MULTIPLE_LOW), multiple_high: String(DEFAULT_MULTIPLE_HIGH), target_exit_date: '',
  };
}

const show = (n: number | null | undefined) => (n == null ? '' : String(n));

export function profileToForm(p: ValuationProfile | null): NumbersForm {
  if (!p) return emptyNumbersForm();
  return {
    annual_revenue: show(p.annual_revenue), owner_earnings: show(p.owner_earnings), revenue_growth_pct: show(p.revenue_growth_pct),
    recurring_revenue_pct: show(p.recurring_revenue_pct), top_customer_pct: show(p.top_customer_pct), cash_on_hand: show(p.cash_on_hand),
    total_debt: show(p.total_debt), multiple_low: show(p.multiple_low), multiple_high: show(p.multiple_high), target_exit_date: p.target_exit_date ?? '',
  };
}

/** "$1,250,000", "1 250 000" and "1250000.50" all parse; anything else returns NaN. Empty returns null. */
export function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, '');
  if (s === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Number(s);
}

export function validateNumbers(form: NumbersForm, today: Date = new Date()): NumbersErrors {
  const errors: NumbersErrors = {};
  const check = (key: keyof NumbersForm, min: number, max: number, label: string, required = false) => {
    const n = parseNumber(form[key]);
    if (n === null) { if (required) errors[key] = `${label} is required.`; return; }
    if (Number.isNaN(n)) errors[key] = `${label} must be a number.`;
    else if (n < min || n > max) errors[key] = `${label} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`;
  };
  check('annual_revenue', 0, 10_000_000_000, 'Revenue');
  check('owner_earnings', -1_000_000_000, 10_000_000_000, 'Owner earnings');
  check('revenue_growth_pct', -100, 1000, 'Growth');
  check('recurring_revenue_pct', 0, 100, 'Recurring revenue');
  check('top_customer_pct', 0, 100, 'Top customer share');
  check('cash_on_hand', 0, 10_000_000_000, 'Cash');
  check('total_debt', 0, 10_000_000_000, 'Debt');
  check('multiple_low', 0.5, 10, 'Low multiple', true);
  check('multiple_high', 0.5, 10, 'High multiple', true);
  const lo = parseNumber(form.multiple_low);
  const hi = parseNumber(form.multiple_high);
  if (!errors.multiple_low && !errors.multiple_high && lo != null && hi != null && hi <= lo) errors.multiple_high = 'High multiple must be greater than the low multiple.';
  if (form.target_exit_date) {
    const d = new Date(`${form.target_exit_date}T00:00:00`);
    const floor = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    if (Number.isNaN(d.getTime())) errors.target_exit_date = 'Enter a valid date.';
    else if (d < floor) errors.target_exit_date = 'Target exit date cannot be more than a year in the past.';
  }
  return errors;
}

export function formToRow(form: NumbersForm) {
  const num = (s: string) => { const n = parseNumber(s); return n == null || Number.isNaN(n) ? null : n; };
  return {
    annual_revenue: num(form.annual_revenue),
    owner_earnings: num(form.owner_earnings),
    revenue_growth_pct: num(form.revenue_growth_pct),
    recurring_revenue_pct: num(form.recurring_revenue_pct),
    top_customer_pct: num(form.top_customer_pct),
    cash_on_hand: num(form.cash_on_hand),
    total_debt: num(form.total_debt),
    multiple_low: num(form.multiple_low) ?? DEFAULT_MULTIPLE_LOW,
    multiple_high: num(form.multiple_high) ?? DEFAULT_MULTIPLE_HIGH,
    target_exit_date: form.target_exit_date || null,
  };
}

export function profileInputs(p: ValuationProfile | null): ValuationInputs {
  return {
    annual_revenue: p?.annual_revenue ?? null,
    owner_earnings: p?.owner_earnings ?? null,
    revenue_growth_pct: p?.revenue_growth_pct ?? null,
    recurring_revenue_pct: p?.recurring_revenue_pct ?? null,
    top_customer_pct: p?.top_customer_pct ?? null,
    cash_on_hand: p?.cash_on_hand ?? null,
    total_debt: p?.total_debt ?? null,
    multiple_low: p?.multiple_low ?? DEFAULT_MULTIPLE_LOW,
    multiple_high: p?.multiple_high ?? DEFAULT_MULTIPLE_HIGH,
  };
}

export function answersEqual(a: Answers, b: Answers): boolean {
  return QUESTIONS.every((q) => a[q.key] === b[q.key]);
}

// ============================================================
// Errors
// ============================================================

interface PgLikeError { code?: string; message?: string }

export function isValuationUnavailable(err: unknown): boolean {
  const e = (err ?? {}) as PgLikeError;
  const msg = e.message ?? '';
  if (e.code === '42P01' || e.code === '42883' || e.code === 'PGRST205' || e.code === 'PGRST202') return true;
  return /(valuation_profiles|data_room_items|valuation_snapshots)/.test(msg) && /does not exist|schema cache/.test(msg);
}

export function describeValuationError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof Error && !('code' in err)) return err.message || fallback;
  const e = (err ?? {}) as PgLikeError;
  const msg = e.message ?? '';
  if (isValuationUnavailable(err)) return 'Valuation is not set up on this database yet. Apply the latest migration and reload.';
  if (e.code === '42501' || msg.includes('row-level security')) return 'Only the account owner can view or change valuation data.';
  if (e.code === '23514') return 'One of the numbers is out of range. Check the form and try again.';
  return msg && msg.length < 140 ? msg : fallback;
}

// ============================================================
// Network (owner only; RLS enforces the same rule on the server)
// ============================================================

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeProfile(row: Record<string, unknown>): ValuationProfile {
  return {
    id: String(row.id),
    annual_revenue: toNum(row.annual_revenue),
    owner_earnings: toNum(row.owner_earnings),
    revenue_growth_pct: toNum(row.revenue_growth_pct),
    recurring_revenue_pct: toNum(row.recurring_revenue_pct),
    top_customer_pct: toNum(row.top_customer_pct),
    cash_on_hand: toNum(row.cash_on_hand),
    total_debt: toNum(row.total_debt),
    multiple_low: toNum(row.multiple_low) ?? DEFAULT_MULTIPLE_LOW,
    multiple_high: toNum(row.multiple_high) ?? DEFAULT_MULTIPLE_HIGH,
    answers: sanitizeAnswers(row.answers),
    target_exit_date: (row.target_exit_date as string | null) ?? null,
    updated_at: String(row.updated_at ?? ''),
  };
}

function normalizeSnapshot(row: Record<string, unknown>): ValuationSnapshot {
  const dims = row.dimension_scores && typeof row.dimension_scores === 'object' ? (row.dimension_scores as Record<string, number>) : {};
  return {
    id: String(row.id),
    label: (row.label as string | null) ?? null,
    readiness_score: toNum(row.readiness_score),
    assessment_score: toNum(row.assessment_score),
    data_room_score: toNum(row.data_room_score),
    value_low: toNum(row.value_low),
    value_mid: toNum(row.value_mid),
    value_high: toNum(row.value_high),
    owner_earnings: toNum(row.owner_earnings),
    multiple_mid: toNum(row.multiple_mid),
    dimension_scores: dims,
    created_at: String(row.created_at ?? ''),
  };
}

export async function fetchValuationBundle(accountOwnerId: string): Promise<ValuationBundle> {
  const [profileRes, itemsRes, snapsRes] = await Promise.all([
    supabase.from('valuation_profiles').select('*').eq('user_id', accountOwnerId).maybeSingle(),
    supabase.from('data_room_items').select('item_key, status, note, updated_at').eq('user_id', accountOwnerId),
    supabase.from('valuation_snapshots').select('*').eq('user_id', accountOwnerId).order('created_at', { ascending: false }).limit(SNAPSHOT_LIMIT),
  ]);
  if (profileRes.error) throw profileRes.error;
  if (itemsRes.error) throw itemsRes.error;
  if (snapsRes.error) throw snapsRes.error;
  return {
    profile: profileRes.data ? normalizeProfile(profileRes.data as Record<string, unknown>) : null,
    items: (itemsRes.data ?? []) as DataRoomRow[],
    snapshots: (snapsRes.data ?? []).map((r: unknown) => normalizeSnapshot(r as Record<string, unknown>)),
  };
}

export async function saveNumbers(accountOwnerId: string, form: NumbersForm): Promise<ValuationProfile> {
  const { data, error } = await supabase
    .from('valuation_profiles')
    .upsert({ user_id: accountOwnerId, ...formToRow(form) }, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return normalizeProfile(data as Record<string, unknown>);
}

export async function saveAnswers(accountOwnerId: string, answers: Answers): Promise<ValuationProfile> {
  const { data, error } = await supabase
    .from('valuation_profiles')
    .upsert({ user_id: accountOwnerId, answers: sanitizeAnswers(answers) }, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return normalizeProfile(data as Record<string, unknown>);
}

export async function saveDataRoomItem(accountOwnerId: string, itemKey: string, status: DataRoomStatus, note: string | null): Promise<DataRoomRow> {
  if (!DATA_ROOM_ITEMS.some((i) => i.key === itemKey)) throw new Error('Unknown checklist item.');
  const cleanNote = note?.trim() ? note.trim().slice(0, DATA_ROOM_NOTE_MAX) : null;
  const { data, error } = await supabase
    .from('data_room_items')
    .upsert({ user_id: accountOwnerId, item_key: itemKey, status, note: cleanNote }, { onConflict: 'user_id,item_key' })
    .select('item_key, status, note, updated_at')
    .single();
  if (error) throw error;
  return data as DataRoomRow;
}

export async function saveSnapshot(
  accountOwnerId: string,
  args: { label: string; readiness: number | null; assessment: AssessmentResult; dataRoom: DataRoomResult; estimate: ValuationEstimate; inputs: ValuationInputs },
): Promise<ValuationSnapshot> {
  const dims: Record<string, number> = {};
  for (const d of args.assessment.dimensions) if (d.score != null) dims[d.key] = d.score;
  const { data, error } = await supabase
    .from('valuation_snapshots')
    .insert({
      user_id: accountOwnerId,
      label: args.label.trim().slice(0, 120) || null,
      readiness_score: args.readiness,
      assessment_score: args.assessment.score,
      data_room_score: args.dataRoom.score,
      value_low: args.estimate.canCompute ? args.estimate.valueLow : null,
      value_mid: args.estimate.canCompute ? args.estimate.valueMid : null,
      value_high: args.estimate.canCompute ? args.estimate.valueHigh : null,
      owner_earnings: args.inputs.owner_earnings,
      multiple_mid: args.estimate.canCompute ? args.estimate.multipleMid : null,
      dimension_scores: dims,
    })
    .select('*')
    .single();
  if (error) throw error;
  return normalizeSnapshot(data as Record<string, unknown>);
}
