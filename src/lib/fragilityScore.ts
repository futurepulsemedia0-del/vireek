/**
 * Business Fragility Score — pure, deterministic, explainable.
 *
 * Answers one question: how badly would a shock (a technician leaves, a supplier
 * stops, a big customer churns, a slow month) hurt this business?
 *
 * Score 0–100, HIGHER = MORE FRAGILE. Each of 8 dimensions maps to a 0–1 risk
 * with a linear ramp between a "safe" and a "dangerous" value, then combines
 * with fixed weights. Dimensions that cannot be measured are excluded and the
 * weights re-normalised, so missing data never looks like safety. Coverage is
 * reported so the owner knows how much of the picture is real.
 *
 * Profitable is not the same as resilient: this scores dependence and buffers,
 * not margin. No I/O here; fragilityApi.ts gathers raw data and persists.
 */

export interface RawJob {
  technician_id: string | null;
  customer_id: string | null;
  revenue: number;
}

export interface RawPurchase {
  vendor_id: string;
  total_cents: number;
}

export interface RawOutcome {
  technician_id: string | null;
  caused_callback: boolean;
  is_rework: boolean;
}

export interface RawFixedExpense {
  amount: number;
  frequency: 'one_time' | 'weekly' | 'biweekly' | 'monthly';
  active: boolean;
}

export interface RawBusinessData {
  completedJobs: RawJob[];
  purchases: RawPurchase[];
  outcomes: RawOutcome[];
  integrationStatuses: string[];
  cashBalance: number | null;
  fixedExpenses: RawFixedExpense[];
  backupCapacityPct: number | null;
  manualWorkPct: number | null;
}

export interface FragilityInputs {
  topTechnicianSharePct: number | null;
  topSupplierSharePct: number | null;
  topCustomersSharePct: number | null;
  cashBufferMonths: number | null;
  backupCapacityPct: number | null;
  qualitySpreadPts: number | null;
  manualWorkPct: number | null;
  brokenIntegrationPct: number | null;
}

export type ComponentKey = 'technician' | 'supplier' | 'customer' | 'cash' | 'capacity' | 'quality' | 'manual' | 'integrations';
export type FragilityBand = 'resilient' | 'exposed' | 'fragile' | 'critical';

export interface ComponentResult {
  key: ComponentKey;
  label: string;
  value: number | null;
  display: string | null;
  risk: number | null;
  /** Points this dimension adds to the final score (0 when unmeasured). */
  contribution: number;
  advice: string | null;
}

export interface FragilityReport {
  score: number | null;
  band: FragilityBand | null;
  scalability: number | null;
  coverage: number;
  components: ComponentResult[];
  weakestLinks: ComponentResult[];
}

export const FRAGILITY = {
  minMeasured: 5,
  minTechnicianJobs: 10,
  minSupplierOrders: 3,
  minCustomerJobs: 10,
  minCallbackJobs: 5,
} as const;

const MONTHLY_FACTOR: Record<RawFixedExpense['frequency'], number> = {
  one_time: 0,
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
};

const BROKEN_STATUSES: ReadonlySet<string> = new Set(['error', 'disconnected', 'expired', 'failed', 'revoked']);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const pct = (v: number) => `${Math.round(v)}%`;

/** 0 = safe, 1 = dangerous. Works for "higher is worse" and "lower is worse" alike. */
export function riskOf(value: number, safe: number, danger: number): number {
  return clamp01((value - safe) / (danger - safe));
}

export function bandOf(score: number): FragilityBand {
  if (score < 30) return 'resilient';
  if (score < 55) return 'exposed';
  if (score < 75) return 'fragile';
  return 'critical';
}

interface ComponentSpec {
  key: ComponentKey;
  label: string;
  weight: number;
  safe: number;
  danger: number;
  scalability: boolean;
  read: (i: FragilityInputs) => number | null;
  format: (v: number) => string;
  advice: (v: number) => string;
}

const SPECS: ComponentSpec[] = [
  {
    key: 'technician', label: 'Technician dependence', weight: 15, safe: 25, danger: 60, scalability: false,
    read: (i) => i.topTechnicianSharePct, format: pct,
    advice: (v) => `One technician completes ${pct(v)} of jobs. Cross-train a second technician on your top job types and spread new bookings across the team.`,
  },
  {
    key: 'supplier', label: 'Supplier dependence', weight: 10, safe: 50, danger: 95, scalability: false,
    read: (i) => i.topSupplierSharePct, format: pct,
    advice: (v) => `One supplier holds ${pct(v)} of parts spend. Approve a second vendor for your most-used parts so one delay cannot stop the schedule.`,
  },
  {
    key: 'customer', label: 'Customer concentration', weight: 15, safe: 40, danger: 85, scalability: false,
    read: (i) => i.topCustomersSharePct, format: pct,
    advice: (v) => `Your top 5 customers produce ${pct(v)} of revenue. Widen the base with review requests, referrals and maintenance plans.`,
  },
  {
    key: 'cash', label: 'Cash buffer', weight: 20, safe: 3, danger: 0.5, scalability: false,
    read: (i) => i.cashBufferMonths, format: (v) => `${v.toFixed(1)} mo`,
    advice: (v) => `Cash covers ${v.toFixed(1)} months of fixed costs. Aim for at least 3; until then, delay discretionary spend and watch collections closely.`,
  },
  {
    key: 'capacity', label: 'Backup capacity', weight: 10, safe: 15, danger: 0, scalability: true,
    read: (i) => i.backupCapacityPct, format: pct,
    advice: (v) => `Only ${pct(v)} spare technician capacity. Keep about 15% free for surges and sickness, or agree a standby subcontractor.`,
  },
  {
    key: 'quality', label: 'Quality spread', weight: 10, safe: 5, danger: 30, scalability: true,
    read: (i) => i.qualitySpreadPts, format: (v) => `${Math.round(v)} pts`,
    advice: (v) => `Callback rates differ by ${Math.round(v)} points between technicians. Coach the highest-callback technician using the job checklist.`,
  },
  {
    key: 'manual', label: 'Manual work', weight: 10, safe: 30, danger: 90, scalability: true,
    read: (i) => i.manualWorkPct, format: pct,
    advice: (v) => `${pct(v)} of work still runs by hand. Automate booking, dispatch and invoicing first; these limit how fast you can grow.`,
  },
  {
    key: 'integrations', label: 'Fragile integrations', weight: 10, safe: 0, danger: 50, scalability: true,
    read: (i) => i.brokenIntegrationPct, format: pct,
    advice: (v) => `${pct(v)} of connected integrations are failing. A silent sync failure loses data; reconnect them and confirm the next sync.`,
  },
];

function countBy<T>(rows: T[], key: (r: T) => string | null, weight: (r: T) => number = () => 1): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (k) out.set(k, (out.get(k) ?? 0) + weight(r));
  }
  return out;
}

/** Share (%) of the total held by the `topN` largest entries. */
function topShare(totals: Map<string, number>, topN: number): number | null {
  const values = [...totals.values()];
  const sum = values.reduce((s, v) => s + v, 0);
  if (sum <= 0) return null;
  const top = values.sort((a, b) => b - a).slice(0, topN).reduce((s, v) => s + v, 0);
  return (top / sum) * 100;
}

/** Spread (in percentage points) between the best and worst callback rate across technicians. */
function qualitySpread(outcomes: RawOutcome[]): number | null {
  const byTech = new Map<string, { n: number; callbacks: number }>();
  for (const o of outcomes) {
    if (!o.technician_id || o.is_rework) continue;
    const entry = byTech.get(o.technician_id) ?? { n: 0, callbacks: 0 };
    entry.n += 1;
    if (o.caused_callback) entry.callbacks += 1;
    byTech.set(o.technician_id, entry);
  }
  const rates = [...byTech.values()]
    .filter((e) => e.n >= FRAGILITY.minCallbackJobs)
    .map((e) => e.callbacks / e.n);
  if (rates.length < 2) return null;
  return (Math.max(...rates) - Math.min(...rates)) * 100;
}

/** Turns raw rows into the eight measured inputs. Returns null for anything too thin to trust. */
export function deriveInputs(raw: RawBusinessData): FragilityInputs {
  const techJobs = countBy(raw.completedJobs, (j) => j.technician_id);
  const techTotal = [...techJobs.values()].reduce((s, v) => s + v, 0);

  const customerJobs = raw.completedJobs.filter((j) => j.customer_id !== null).length;
  const revenueByCustomer = countBy(raw.completedJobs, (j) => j.customer_id, (j) => j.revenue);

  const spendBySupplier = countBy(raw.purchases, (p) => p.vendor_id, (p) => p.total_cents);

  const monthlyFixed = raw.fixedExpenses
    .filter((e) => e.active)
    .reduce((s, e) => s + e.amount * MONTHLY_FACTOR[e.frequency], 0);

  const brokenCount = raw.integrationStatuses.filter((s) => BROKEN_STATUSES.has(s)).length;

  return {
    topTechnicianSharePct: techTotal >= FRAGILITY.minTechnicianJobs ? topShare(techJobs, 1) : null,
    topSupplierSharePct: raw.purchases.length >= FRAGILITY.minSupplierOrders ? topShare(spendBySupplier, 1) : null,
    topCustomersSharePct: customerJobs >= FRAGILITY.minCustomerJobs ? topShare(revenueByCustomer, 5) : null,
    cashBufferMonths: raw.cashBalance !== null && monthlyFixed > 0 ? raw.cashBalance / monthlyFixed : null,
    backupCapacityPct: raw.backupCapacityPct,
    qualitySpreadPts: qualitySpread(raw.outcomes),
    manualWorkPct: raw.manualWorkPct,
    brokenIntegrationPct: raw.integrationStatuses.length > 0 ? (brokenCount / raw.integrationStatuses.length) * 100 : null,
  };
}

/** Computes the score, scalability, coverage and the weakest links. Pure. */
export function scoreFragility(inputs: FragilityInputs): FragilityReport {
  const rows = SPECS.map((spec) => {
    const value = spec.read(inputs);
    const risk = value === null ? null : riskOf(value, spec.safe, spec.danger);
    return { spec, value, risk };
  });

  const measured = rows.filter((r) => r.risk !== null);
  const coverage = measured.length / SPECS.length;
  const weightSum = measured.reduce((s, r) => s + r.spec.weight, 0);
  const canScore = measured.length >= FRAGILITY.minMeasured;

  const score = canScore
    ? round1((measured.reduce((s, r) => s + r.spec.weight * (r.risk ?? 0), 0) / weightSum) * 100)
    : null;

  const scaleRows = measured.filter((r) => r.spec.scalability);
  const scaleWeight = scaleRows.reduce((s, r) => s + r.spec.weight, 0);
  const scalability = scaleRows.length >= 2
    ? round1(100 - (scaleRows.reduce((s, r) => s + r.spec.weight * (r.risk ?? 0), 0) / scaleWeight) * 100)
    : null;

  const components: ComponentResult[] = rows.map(({ spec, value, risk }) => ({
    key: spec.key,
    label: spec.label,
    value,
    display: value === null ? null : spec.format(value),
    risk,
    contribution: canScore && risk !== null ? (spec.weight * risk / weightSum) * 100 : 0,
    advice: value === null ? null : spec.advice(value),
  }));

  const weakestLinks = components
    .filter((c) => c.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  return {
    score,
    band: score === null ? null : bandOf(score),
    scalability,
    coverage,
    components,
    weakestLinks,
  };
}
