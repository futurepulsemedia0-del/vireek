/**
 * Vireek Insights - pure types + helpers (no network, no React).
 * Everything here is unit-tested in insights.test.ts. Data access lives in
 * insightsApi.ts; privacy is enforced in the database, never here.
 */

export const INSIGHTS_CONSENT_VERSION = 1;
export const INSIGHTS_MIN_BUSINESSES = 10;

export type InsightMetric = 'avg_ticket_cents' | 'close_rate_pct' | 'response_hours' | 'leads_per_business' | 'demand_index';
export type InsightUnit = 'cents' | 'percent' | 'hours' | 'count' | 'index';
export type InsightDirection = 'higher_is_better' | 'lower_is_better' | 'neutral';
export type ContributorBand = '10-19' | '20-49' | '50-99' | '100+';

export interface InsightPeriod {
  period_label: string;
  period_start: string;
  period_end: string;
  published_at: string;
  contributors_rounded: number;
}

export interface InsightCell {
  period_label: string;
  trade: string;
  region_key: string;
  metric: InsightMetric;
  unit: InsightUnit;
  direction: InsightDirection;
  contributor_band: ContributorBand;
  p25: number;
  p50: number;
  p75: number;
  qoq_change_pct: number | null;
}

export const METRIC_ORDER: InsightMetric[] = ['avg_ticket_cents', 'close_rate_pct', 'response_hours', 'leads_per_business', 'demand_index'];

export const METRIC_META: Record<InsightMetric, { label: string; description: string }> = {
  avg_ticket_cents: { label: 'Average ticket', description: 'Average paid job value per business.' },
  close_rate_pct: { label: 'Close rate', description: 'Quotes accepted out of quotes sent.' },
  response_hours: { label: 'Lead response time', description: 'Average time from new lead to quote sent.' },
  leads_per_business: { label: 'Lead volume', description: 'New leads per business in the quarter.' },
  demand_index: { label: 'Demand index', description: 'Leads vs the prior quarter (100 = flat).' },
};

export const TRADE_LABELS: Record<string, string> = {
  all: 'All trades',
  hvac: 'HVAC',
  plumbing: 'Plumbing',
  roofing: 'Roofing',
  electrical: 'Electrical',
  restoration: 'Restoration',
  locksmith: 'Locksmith',
  'pest-control': 'Pest control',
  'lawn-care': 'Lawn care',
  cleaning: 'Cleaning',
  'pool-service': 'Pool service',
  'appliance-repair': 'Appliance repair',
  solar: 'Solar',
  painting: 'Painting',
};

export const US_STATES: Record<string, string> = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California', co: 'Colorado', ct: 'Connecticut',
  de: 'Delaware', dc: 'District of Columbia', fl: 'Florida', ga: 'Georgia', hi: 'Hawaii', id: 'Idaho', il: 'Illinois',
  in: 'Indiana', ia: 'Iowa', ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland',
  ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi', mo: 'Missouri', mt: 'Montana',
  ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey', nm: 'New Mexico', ny: 'New York',
  nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania',
  ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota', tn: 'Tennessee', tx: 'Texas', ut: 'Utah',
  vt: 'Vermont', va: 'Virginia', wa: 'Washington', wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming',
};

export function tradeLabel(key: string): string {
  if (TRADE_LABELS[key]) return TRADE_LABELS[key];
  return key
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function regionLabel(key: string): string {
  if (key === 'all') return 'United States';
  return US_STATES[key] ?? key.toUpperCase();
}

/** '2027-Q4' -> 'Q4 2027'. Unknown shapes are returned unchanged. */
export function periodLabelHuman(label: string): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(label);
  return m ? `Q${m[2]} ${m[1]}` : label;
}

export function contributorBandLabel(band: ContributorBand): string {
  return band === '100+' ? '100+ businesses' : `${band} businesses`;
}

export function formatInsightValue(unit: InsightUnit, value: number): string {
  if (!Number.isFinite(value)) return '-';
  switch (unit) {
    case 'cents':
      return `$${Math.round(value / 100).toLocaleString('en-US')}`;
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'hours':
      return value < 1 ? `${Math.round(value * 60)} min` : `${value.toFixed(1)} h`;
    case 'count':
      return Math.round(value).toLocaleString('en-US');
    default:
      return value.toFixed(1);
  }
}

export function formatChange(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '-';
  if (pct === 0) return '0.0%';
  return `${pct > 0 ? '+' : '-'}${Math.abs(pct).toFixed(1)}%`;
}

export type ChangeTone = 'good' | 'bad' | 'neutral';

/** Direction-aware: a falling response time is good news. */
export function changeTone(direction: InsightDirection, pct: number | null): ChangeTone {
  if (pct === null || pct === 0 || direction === 'neutral') return 'neutral';
  const up = pct > 0;
  return (direction === 'higher_is_better') === up ? 'good' : 'bad';
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const METRICS = new Set<string>(METRIC_ORDER);
const BANDS = new Set<string>(['10-19', '20-49', '50-99', '100+']);
const UNITS = new Set<string>(['cents', 'percent', 'hours', 'count', 'index']);
const DIRECTIONS = new Set<string>(['higher_is_better', 'lower_is_better', 'neutral']);

/** Coerces an RPC row; returns null for anything malformed so the UI never renders garbage. */
export function normalizeCell(r: Record<string, unknown>): InsightCell | null {
  const p25 = num(r.p25);
  const p50 = num(r.p50);
  const p75 = num(r.p75);
  if (p25 === null || p50 === null || p75 === null || p25 > p50 || p50 > p75) return null;
  if (!METRICS.has(String(r.metric)) || !BANDS.has(String(r.contributor_band))) return null;
  if (!UNITS.has(String(r.unit)) || !DIRECTIONS.has(String(r.direction))) return null;
  return {
    period_label: String(r.period_label ?? ''),
    trade: String(r.trade ?? 'all'),
    region_key: String(r.region_key ?? 'all'),
    metric: r.metric as InsightMetric,
    unit: r.unit as InsightUnit,
    direction: r.direction as InsightDirection,
    contributor_band: r.contributor_band as ContributorBand,
    p25,
    p50,
    p75,
    qoq_change_pct: num(r.qoq_change_pct),
  };
}

export type TradeRow = Partial<Record<InsightMetric, InsightCell>>;

/** trade -> metric -> cell. 'all' is always first, the rest alphabetical by label. */
export function groupByTrade(cells: InsightCell[]): { trade: string; metrics: TradeRow }[] {
  const map = new Map<string, TradeRow>();
  for (const c of cells) {
    const row = map.get(c.trade) ?? {};
    row[c.metric] = c;
    map.set(c.trade, row);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === 'all' ? -1 : b === 'all' ? 1 : tradeLabel(a).localeCompare(tradeLabel(b))))
    .map(([trade, metrics]) => ({ trade, metrics }));
}

/** 0-100 position of `value` inside [lo, hi]; safe for flat ranges. */
export function rangePosition(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || hi <= lo) return 50;
  return Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100));
}

function csvEscape(v: string | number | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildInsightsCsv(cells: InsightCell[]): string {
  const header = ['period', 'trade', 'region', 'metric', 'unit', 'p25', 'median', 'p75', 'qoq_change_pct', 'businesses'];
  const rows = cells.map((c) =>
    [c.period_label, c.trade, c.region_key, c.metric, c.unit, c.p25, c.p50, c.p75, c.qoq_change_pct, c.contributor_band]
      .map((v) => csvEscape(v as string | number | null))
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

export const CONSENT_SHARED: string[] = [
  'One summary number per metric for each quarter: average ticket, close rate, lead response time, lead volume and demand growth.',
  'Your trade and US state, taken from your business profile.',
];

export const CONSENT_NEVER_SHARED: string[] = [
  'Customer names, phone numbers, addresses, calls, messages or any individual job or quote.',
  'Your business name or any identifier that could point back to you.',
];

export const CONSENT_TERMS: string[] = [
  'Your numbers are combined with at least 9 other businesses before anything is published, and small groups are never published.',
  'Only the 25th percentile, median and 75th percentile are released, with small statistical noise added.',
  'You can withdraw at any time. Withdrawal applies from the next quarterly release; quarters already published are not recomputed.',
  'Businesses that share data can see state-level indexes in their dashboard.',
];
