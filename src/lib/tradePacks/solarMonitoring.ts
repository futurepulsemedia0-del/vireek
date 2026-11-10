/**
 * Solar pack — OPTIONAL read-only production-monitoring adapter.
 *
 * Third-party monitoring vendors sit behind `ProductionMonitoringAdapter`. Only a deterministic MOCK ships in this
 * build: no vendor API, scraping or credential is wired up, and nothing is persisted. A real provider must be a
 * server-side adapter (edge function holding the vendor secret) registered in ADAPTERS — never call vendors from
 * the browser, never store customer credentials in client code.
 */

export const MONITORING_PROVIDERS = ['none', 'mock'] as const;
export type MonitoringProvider = (typeof MONITORING_PROVIDERS)[number];

export interface ProductionPoint {
  date: string;
  kwh: number;
}

export interface ProductionSnapshot {
  provider: MonitoringProvider;
  siteRef: string;
  fetchedAt: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  lifetimeKwh: number | null;
  points: ProductionPoint[];
}

export interface DateRange {
  from: string;
  to: string;
}

export interface ProductionMonitoringAdapter {
  readonly id: MonitoringProvider;
  /** Adapters never write to, control or reconfigure a customer's system. */
  readonly readOnly: true;
  getProduction(siteRef: string, range: DateRange): Promise<ProductionSnapshot>;
}

const MAX_DAYS = 366;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const dayMs = 86_400_000;
const parse = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Deterministic fake data (same site + range → same numbers). Offline when the ref ends in "-offline". */
export class MockProductionMonitoringAdapter implements ProductionMonitoringAdapter {
  readonly id = 'mock' as const;
  readonly readOnly = true as const;

  async getProduction(siteRef: string, range: DateRange): Promise<ProductionSnapshot> {
    const ref = siteRef.trim();
    if (!ref) throw new Error('monitoring_site_required');
    const start = parse(range.from);
    const end = parse(range.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('monitoring_range_invalid');
    const days = Math.min(MAX_DAYS, Math.round((end - start) / dayMs) + 1);
    const base = 12 + (fnv1a(ref) % 2000) / 100; // 12–32 kWh/day
    const offline = ref.endsWith('-offline');
    const points: ProductionPoint[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(start + i * dayMs).toISOString().slice(0, 10);
      const wobble = ((fnv1a(`${ref}:${date}`) % 400) - 200) / 1000; // ±20 %
      points.push({ date, kwh: offline && i >= days - 3 ? 0 : Math.round(base * (1 + wobble) * 100) / 100 });
    }
    return {
      provider: 'mock',
      siteRef: ref,
      fetchedAt: new Date().toISOString(),
      status: offline ? 'offline' : 'online',
      lifetimeKwh: Math.round(points.reduce((s, p) => s + p.kwh, 0) * 100) / 100,
      points,
    };
  }
}

const ADAPTERS: Record<Exclude<MonitoringProvider, 'none'>, ProductionMonitoringAdapter> = {
  mock: new MockProductionMonitoringAdapter(),
};

/** null = monitoring not configured. Unknown providers also return null (never guess). */
export function getMonitoringAdapter(id: string | null | undefined): ProductionMonitoringAdapter | null {
  return id && id in ADAPTERS ? ADAPTERS[id as keyof typeof ADAPTERS] : null;
}

/** Rule-of-thumb daily yield (kWh) — a heuristic for triage, not a performance guarantee. */
export function expectedDailyKwh(systemKw: number, peakSunHours = 4, derate = 0.8): number {
  return Math.round(systemKw * peakSunHours * derate * 100) / 100;
}

export interface ProductionSummary {
  totalKwh: number;
  avgDailyKwh: number;
  ratio: number | null;
  /** Needs ≥ 3 days of data and a ratio below 0.7; the threshold is a configurable heuristic. */
  underperforming: boolean;
}

export function summarizeProduction(s: ProductionSnapshot, expectedDaily?: number | null, threshold = 0.7): ProductionSummary {
  const total = Math.round(s.points.reduce((a, p) => a + p.kwh, 0) * 100) / 100;
  const avg = s.points.length ? Math.round((total / s.points.length) * 100) / 100 : 0;
  const ratio = expectedDaily && expectedDaily > 0 && s.points.length ? Math.round((avg / expectedDaily) * 100) / 100 : null;
  return { totalKwh: total, avgDailyKwh: avg, ratio, underperforming: ratio !== null && s.points.length >= 3 && ratio < threshold };
}
