/**
 * Staff usage & margin — pure domain logic for /staff/usage (no I/O).
 * Data: staff_usage_report() in 20270412000000_staff_usage_report.sql · Access: staffUsageApi.ts
 *
 * ALL money here is an ESTIMATE: AI cost comes from list-price math in ai_usage_logs, voice cost is a
 * $/minute assumption, revenue is the plan's list price (prorated) plus metered overage.
 */
import { PRICING_PLANS, parseOverageRate, type PlanId } from './pricing';

export interface TenantUsageRow {
  account_id: string;
  email: string | null;
  company_name: string | null;
  plan: string | null;
  ai_cost_usd: number;
  ai_calls: number;
  ai_failed: number;
  ai_fallbacks: number;
  input_tokens: number;
  output_tokens: number;
  voice_seconds: number;
  voice_calls: number;
}
export interface DailyUsage { day: string; ai_cost_usd: number; ai_calls: number; voice_seconds: number }
export interface ProviderUsage {
  provider: string; model: string; cost_usd: number; calls: number;
  input_tokens: number; output_tokens: number; failed: number; fallbacks: number;
}
export interface TaskUsage { task: string; cost_usd: number; calls: number }
export interface UsageReport {
  tenants: TenantUsageRow[];
  daily: DailyUsage[];
  providers: ProviderUsage[];
  tasks: TaskUsage[];
  unattributed_cost_usd: number;
  truncated: boolean;
}

/** Blended telephony + STT/TTS + voice-platform cost per call minute. An assumption, editable on the page. */
export const DEFAULT_VOICE_COST_PER_MIN = 0.12;
export const THIN_MARGIN_PCT = 30;

export const PERIODS = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'mtd', label: 'This month' },
] as const;
export type PeriodKey = (typeof PERIODS)[number]['key'];

const DAY_MS = 86_400_000;

/** [start, end) in UTC. `days` is the (possibly fractional) length used to prorate monthly prices. */
export function periodWindow(key: PeriodKey, now: Date = new Date()): { start: Date; end: Date; days: number } {
  const end = new Date(now.getTime());
  if (key === 'mtd') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { start, end, days: Math.max(1, (end.getTime() - start.getTime()) / DAY_MS) };
  }
  const n = key === '7d' ? 7 : key === '30d' ? 30 : 90;
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: new Date(todayStart - (n - 1) * DAY_MS), end, days: n };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
export interface PlanEconomics {
  id: PlanId | 'unknown';
  name: string;
  /** null = custom/unknown price (Enterprise, unrecognised plan) */
  monthlyPrice: number | null;
  includedMinutes: number; // Infinity for unlimited
  overageRate: number | null;
}

export function planEconomics(planId: string | null | undefined): PlanEconomics {
  const plan = PRICING_PLANS.find((p) => p.id === planId);
  if (!plan) return { id: 'unknown', name: planId ? String(planId) : 'Unknown', monthlyPrice: null, includedMinutes: 0, overageRate: null };
  const m = plan.minutes.replace(/,/g, '').match(/(\d+)/);
  return {
    id: plan.id,
    name: plan.name,
    monthlyPrice: plan.monthly,
    includedMinutes: m ? parseInt(m[1], 10) : Infinity,
    overageRate: parseOverageRate(plan.overage),
  };
}

// ---------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------
export type Health = 'healthy' | 'thin' | 'loss' | 'unpriced';

export interface TenantEconomics extends TenantUsageRow {
  planName: string;
  voiceMinutes: number;
  voiceCostUsd: number;
  totalCostUsd: number;
  /** null when the plan has no list price (Enterprise / unknown) */
  revenueUsd: number | null;
  marginUsd: number | null;
  /** null when revenue is 0 or unknown */
  marginPct: number | null;
  health: Health;
}

export function computeTenantEconomics(row: TenantUsageRow, voiceCostPerMin: number, days: number): TenantEconomics {
  const plan = planEconomics(row.plan);
  const voiceMinutes = row.voice_seconds / 60;
  const voiceCostUsd = voiceMinutes * voiceCostPerMin;
  const totalCostUsd = row.ai_cost_usd + voiceCostUsd;

  let revenueUsd: number | null = null;
  if (plan.monthlyPrice !== null) {
    const subscription = (plan.monthlyPrice * days) / 30;
    const includedForPeriod = (plan.includedMinutes * days) / 30;
    const overageMinutes = plan.overageRate !== null ? Math.max(0, voiceMinutes - includedForPeriod) : 0;
    revenueUsd = subscription + overageMinutes * (plan.overageRate ?? 0);
  }

  const marginUsd = revenueUsd === null ? null : revenueUsd - totalCostUsd;
  const marginPct = revenueUsd !== null && revenueUsd > 0 && marginUsd !== null ? (marginUsd / revenueUsd) * 100 : null;
  let health: Health;
  if (revenueUsd === null) health = 'unpriced';
  else if (marginUsd !== null && marginUsd < 0) health = 'loss';
  else if (marginPct !== null && marginPct < THIN_MARGIN_PCT) health = 'thin';
  else health = 'healthy';

  return { ...row, planName: plan.name, voiceMinutes, voiceCostUsd, totalCostUsd, revenueUsd, marginUsd, marginPct, health };
}

export interface UsageTotals {
  tenants: number;
  revenueUsd: number;
  aiCostUsd: number;
  voiceCostUsd: number;
  totalCostUsd: number;
  marginUsd: number;
  /** null when no priced revenue */
  marginPct: number | null;
  lossMakers: number;
  thin: number;
  unpricedTenants: number;
  aiCalls: number;
  aiFailed: number;
  voiceMinutes: number;
  unattributedCostUsd: number;
}

/** Margin is computed over priced tenants only so Enterprise/unknown plans don't distort the percentage. */
export function computeTotals(rows: TenantEconomics[], unattributedCostUsd = 0): UsageTotals {
  const t: UsageTotals = {
    tenants: rows.length, revenueUsd: 0, aiCostUsd: 0, voiceCostUsd: 0, totalCostUsd: 0, marginUsd: 0,
    marginPct: null, lossMakers: 0, thin: 0, unpricedTenants: 0, aiCalls: 0, aiFailed: 0, voiceMinutes: 0,
    unattributedCostUsd,
  };
  let pricedCost = 0;
  for (const r of rows) {
    t.aiCostUsd += r.ai_cost_usd;
    t.voiceCostUsd += r.voiceCostUsd;
    t.totalCostUsd += r.totalCostUsd;
    t.aiCalls += r.ai_calls;
    t.aiFailed += r.ai_failed;
    t.voiceMinutes += r.voiceMinutes;
    if (r.health === 'unpriced') t.unpricedTenants++;
    else {
      t.revenueUsd += r.revenueUsd ?? 0;
      pricedCost += r.totalCostUsd;
      if (r.health === 'loss') t.lossMakers++;
      if (r.health === 'thin') t.thin++;
    }
  }
  t.marginUsd = t.revenueUsd - pricedCost;
  t.marginPct = t.revenueUsd > 0 ? (t.marginUsd / t.revenueUsd) * 100 : null;
  return t;
}

// ---------------------------------------------------------------------------
// Table: filter / sort / paginate
// ---------------------------------------------------------------------------
export type SortKey = 'name' | 'plan' | 'revenue' | 'ai' | 'voice' | 'cost' | 'margin' | 'marginPct';
export type SortDir = 'asc' | 'desc';
export type HealthFilter = 'all' | Health;

const displayName = (r: TenantEconomics) => (r.company_name?.trim() || r.email || r.account_id).toLowerCase();

const sortValue = (r: TenantEconomics, k: SortKey): number | string | null => {
  switch (k) {
    case 'name': return displayName(r);
    case 'plan': return r.planName.toLowerCase();
    case 'revenue': return r.revenueUsd;
    case 'ai': return r.ai_cost_usd;
    case 'voice': return r.voiceCostUsd;
    case 'cost': return r.totalCostUsd;
    case 'margin': return r.marginUsd;
    case 'marginPct': return r.marginPct;
  }
};

export function filterAndSort(
  rows: TenantEconomics[],
  opts: { query: string; health: HealthFilter; sortKey: SortKey; sortDir: SortDir },
): TenantEconomics[] {
  const q = opts.query.trim().toLowerCase();
  const out = rows.filter(
    (r) =>
      (opts.health === 'all' || r.health === opts.health) &&
      (!q || displayName(r).includes(q) || (r.email ?? '').toLowerCase().includes(q) || r.account_id.toLowerCase().startsWith(q)),
  );
  const dir = opts.sortDir === 'asc' ? 1 : -1;
  return out.sort((a, b) => {
    const av = sortValue(a, opts.sortKey);
    const bv = sortValue(b, opts.sortKey);
    // Unknown (null) values always sort last regardless of direction.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
    return ((av as number) - (bv as number)) * dir;
  });
}

export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  return { items: items.slice((p - 1) * pageSize, p * pageSize), pages, page: p };
}

// ---------------------------------------------------------------------------
// Daily series
// ---------------------------------------------------------------------------
export interface DailyCostPoint { day: string; aiCostUsd: number; voiceCostUsd: number; totalUsd: number }

/** Fills missing days with zeros so the chart's x-axis is continuous. */
export function buildDailyCosts(daily: DailyUsage[], start: Date, end: Date, voiceCostPerMin: number): DailyCostPoint[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: DailyCostPoint[] = [];
  const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let t = first; t <= last; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const d = byDay.get(day);
    const ai = d?.ai_cost_usd ?? 0;
    const voice = ((d?.voice_seconds ?? 0) / 60) * voiceCostPerMin;
    out.push({ day, aiCostUsd: ai, voiceCostUsd: voice, totalUsd: ai + voice });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting + CSV + parsing
// ---------------------------------------------------------------------------
export function formatUsd(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = opts.compact ? (abs >= 100 ? 0 : 2) : abs > 0 && abs < 1 ? 4 : 2;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? '-' : ''}$${s}`;
}

export function formatPct(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${Math.round(n)}%`;
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min';
  return minutes >= 100 ? `${Math.round(minutes).toLocaleString('en-US')} min` : `${minutes.toFixed(1)} min`;
}

/** RFC-4180 quoting plus spreadsheet-formula neutralisation (=, +, -, @ at the start of a cell). */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v;
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tenantsToCsv(rows: TenantEconomics[]): string {
  const header = ['account_id', 'company', 'email', 'plan', 'revenue_usd', 'ai_cost_usd', 'voice_minutes', 'voice_cost_usd', 'total_cost_usd', 'margin_usd', 'margin_pct', 'health', 'ai_calls', 'ai_failed'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.account_id, r.company_name, r.email, r.planName,
        r.revenueUsd === null ? '' : r.revenueUsd.toFixed(2), r.ai_cost_usd.toFixed(4), r.voiceMinutes.toFixed(1),
        r.voiceCostUsd.toFixed(4), r.totalCostUsd.toFixed(4), r.marginUsd === null ? '' : r.marginUsd.toFixed(2),
        r.marginPct === null ? '' : r.marginPct.toFixed(1), r.health, r.ai_calls, r.ai_failed,
      ].map(csvCell).join(','),
    );
  }
  return lines.join('\n');
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Defensive parse of the RPC payload (bigint/numeric may arrive as strings). Returns null when unusable. */
export function parseReport(raw: unknown): UsageReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.tenants)) return null;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    tenants: arr(r.tenants).map((t) => ({
      account_id: String(t.account_id ?? ''), email: str(t.email), company_name: str(t.company_name), plan: str(t.plan),
      ai_cost_usd: num(t.ai_cost_usd), ai_calls: num(t.ai_calls), ai_failed: num(t.ai_failed), ai_fallbacks: num(t.ai_fallbacks),
      input_tokens: num(t.input_tokens), output_tokens: num(t.output_tokens),
      voice_seconds: num(t.voice_seconds), voice_calls: num(t.voice_calls),
    })),
    daily: arr(r.daily).map((d) => ({ day: String(d.day ?? ''), ai_cost_usd: num(d.ai_cost_usd), ai_calls: num(d.ai_calls), voice_seconds: num(d.voice_seconds) })),
    providers: arr(r.providers).map((p) => ({
      provider: String(p.provider ?? ''), model: String(p.model ?? ''), cost_usd: num(p.cost_usd), calls: num(p.calls),
      input_tokens: num(p.input_tokens), output_tokens: num(p.output_tokens), failed: num(p.failed), fallbacks: num(p.fallbacks),
    })),
    tasks: arr(r.tasks).map((t) => ({ task: String(t.task ?? ''), cost_usd: num(t.cost_usd), calls: num(t.calls) })),
    unattributed_cost_usd: num(r.unattributed_cost_usd),
    truncated: r.truncated === true,
  };
}
