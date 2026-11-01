// Shared RUM contract for the rum-ingest edge function. Do not edit the block below without editing src/lib/perf/vitals.ts.
// <contract>
// IDENTICAL in src/lib/perf/vitals.ts and supabase/functions/_shared/rum/vitals.ts
// (guarded by src/lib/perf/rumContract.test.ts). Pure TS, no imports, so it runs in the browser and in Deno.
export type VitalName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';
export type Rating = 'good' | 'needs-improvement' | 'poor';
export type DeviceClass = 'mobile' | 'tablet' | 'desktop';
export type ConnClass = 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
export type NavType = 'navigate' | 'reload' | 'back-forward' | 'back-forward-cache' | 'prerender' | 'restore' | 'unknown';

export interface VitalMetric {
  name: VitalName;
  value: number;
}
export interface VitalsPayload {
  v: 1;
  release: string;
  route: string;
  device: DeviceClass;
  conn: ConnClass;
  nav: NavType;
  metrics: VitalMetric[];
}

export const VITAL_NAMES: readonly VitalName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];
const DEVICES: readonly DeviceClass[] = ['mobile', 'tablet', 'desktop'];
const CONNS: readonly ConnClass[] = ['slow-2g', '2g', '3g', '4g', 'unknown'];
const NAVS: readonly NavType[] = ['navigate', 'reload', 'back-forward', 'back-forward-cache', 'prerender', 'restore', 'unknown'];

/** Google's Core Web Vitals thresholds: [good upper bound, poor lower bound]. */
const THRESHOLDS: Record<VitalName, readonly [number, number]> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};
const MAX_VALUE: Record<VitalName, number> = { LCP: 600_000, CLS: 100, INP: 600_000, FCP: 600_000, TTFB: 600_000 };

export function rate(name: VitalName, value: number): Rating {
  const [good, poor] = THRESHOLDS[name];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pathname only, ids/tokens collapsed to ":id", so no per-user value can reach storage. */
export function normalizeRoute(input: string): string {
  const path = (input.split('#')[0] ?? '').split('?')[0] ?? '';
  const segs = path.split('/').filter(Boolean);
  if (segs[0] === 'wallboard') return '/wallboard/:token';
  const parts = segs.slice(0, 6).map((seg) => {
    const looksLikeToken = seg.length >= 16 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg);
    return UUID.test(seg) || /^\d+$/.test(seg) || looksLikeToken ? ':id' : seg.toLowerCase().slice(0, 40);
  });
  return `/${parts.join('/')}`.slice(0, 120);
}

export type ValidationResult = { ok: true; payload: VitalsPayload } | { ok: false; reason: string };
const fail = (reason: string): ValidationResult => ({ ok: false, reason });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validatePayload(raw: unknown): ValidationResult {
  if (!isRecord(raw) || raw.v !== 1) return fail('shape');
  if (typeof raw.route !== 'string' || raw.route.length === 0 || raw.route.length > 300) return fail('route');
  const device = DEVICES.find((d) => d === raw.device);
  if (!device) return fail('device');
  const release = typeof raw.release === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(raw.release) ? raw.release : 'unknown';
  const conn = CONNS.find((c) => c === raw.conn) ?? 'unknown';
  const nav = NAVS.find((n) => n === raw.nav) ?? 'unknown';
  if (!Array.isArray(raw.metrics) || raw.metrics.length === 0 || raw.metrics.length > 10) return fail('metrics');
  const metrics: VitalMetric[] = [];
  for (const m of raw.metrics as unknown[]) {
    if (!isRecord(m)) return fail('metric');
    const name = VITAL_NAMES.find((n) => n === m.name);
    const value = m.value;
    if (!name || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_VALUE[name]) return fail('metric');
    metrics.push({ name, value });
  }
  return { ok: true, payload: { v: 1, release, route: normalizeRoute(raw.route), device, conn, nav, metrics } };
}
// </contract>
