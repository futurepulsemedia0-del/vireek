/**
 * Shareable read-only dashboard snapshots — pure domain logic (no I/O).
 *
 * A snapshot is a FROZEN set of aggregate widgets computed once by the owner.
 * The public viewer never touches live tables, so a leaked link can expose
 * only the numbers the owner chose to publish — never customer records.
 */

export type WidgetGroup = 'overview' | 'analytics';
export type WidgetKind = 'kpi' | 'series' | 'table';

export type WidgetKey =
  | 'calls_total'
  | 'missed_call_rate'
  | 'emergency_calls'
  | 'jobs_completed'
  | 'revenue_collected'
  | 'lead_conversion'
  | 'positive_sentiment'
  | 'call_volume_trend'
  | 'lead_sources'
  | 'call_outcomes';

export interface WidgetDef {
  key: WidgetKey;
  group: WidgetGroup;
  kind: WidgetKind;
  title: string;
  description: string;
}

export const WIDGET_CATALOG: readonly WidgetDef[] = [
  { key: 'calls_total', group: 'overview', kind: 'kpi', title: 'Calls handled', description: 'Total calls answered in the period' },
  { key: 'missed_call_rate', group: 'overview', kind: 'kpi', title: 'Missed-call rate', description: 'Share of calls that were missed' },
  { key: 'emergency_calls', group: 'overview', kind: 'kpi', title: 'Emergency calls', description: 'Calls flagged as emergencies' },
  { key: 'jobs_completed', group: 'overview', kind: 'kpi', title: 'Jobs completed', description: 'Jobs marked completed' },
  { key: 'revenue_collected', group: 'overview', kind: 'kpi', title: 'Revenue collected', description: 'Paid invoices on jobs created in the period' },
  { key: 'lead_conversion', group: 'overview', kind: 'kpi', title: 'Lead conversion', description: 'Leads won ÷ leads created' },
  { key: 'positive_sentiment', group: 'overview', kind: 'kpi', title: 'Positive sentiment', description: 'Calls with positive sentiment' },
  { key: 'call_volume_trend', group: 'analytics', kind: 'series', title: 'Call volume trend', description: 'Calls per day (weekly for long periods)' },
  { key: 'lead_sources', group: 'analytics', kind: 'table', title: 'Lead sources', description: 'Calls and bookings by source' },
  { key: 'call_outcomes', group: 'analytics', kind: 'table', title: 'Call outcomes', description: 'Calls by final status' },
] as const;

const WIDGET_BY_KEY = new Map<string, WidgetDef>(WIDGET_CATALOG.map((w) => [w.key, w]));

export type WidgetData =
  | { key: WidgetKey; kind: 'kpi'; value: string; hint?: string }
  | { key: WidgetKey; kind: 'series'; points: { label: string; value: number }[] }
  | { key: WidgetKey; kind: 'table'; columns: string[]; rows: string[][] };

export interface SnapshotPayload {
  version: 1;
  generatedAt: string;
  period: { start: string; end: string; days: number };
  widgets: WidgetData[];
}

export const PERIOD_OPTIONS = [7, 30, 90] as const;
export const EXPIRY_OPTIONS = [1, 7, 14, 30, 90] as const;
export const MAX_ACTIVE_SNAPSHOTS = 25;

const DAY = 86_400_000;

/* ------------------------------ source rows ------------------------------ */

export interface CallRow {
  call_datetime: string;
  status: string | null;
  is_emergency: boolean | null;
  sentiment: string | null;
  lead_source: string | null;
}
export interface JobRow {
  created_at: string;
  job_status: string | null;
  invoice_status: string | null;
  invoice_amount: number | null;
}
export interface LeadRow {
  created_at: string;
  stage: string | null;
}
export interface SnapshotSource {
  calls: CallRow[];
  jobs: JobRow[];
  leads: LeadRow[];
}

export interface Period {
  startMs: number;
  endMs: number;
  days: number;
}

/** UTC-day aligned period ending now, so buckets and labels are deterministic. */
export function periodFromDays(days: number, nowMs: number = Date.now()): Period {
  const d = new Date(nowMs);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { startMs: todayStart - (days - 1) * DAY, endMs: todayStart + DAY, days };
}

/* ------------------------------- computing ------------------------------- */

function inPeriod(iso: string, p: Period): boolean {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= p.startMs && t < p.endMs;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

export function formatMoney(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || 'Unknown';
}

function bucketLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function computeWidgets(source: SnapshotSource, keys: WidgetKey[], period: Period): WidgetData[] {
  const calls = source.calls.filter((c) => inPeriod(c.call_datetime, period));
  const jobs = source.jobs.filter((j) => inPeriod(j.created_at, period));
  const leads = source.leads.filter((l) => inPeriod(l.created_at, period));
  const out: WidgetData[] = [];

  for (const key of keys) {
    switch (key) {
      case 'calls_total':
        out.push({ key, kind: 'kpi', value: calls.length.toLocaleString('en-US') });
        break;
      case 'missed_call_rate': {
        const missed = calls.filter((c) => c.status === 'missed').length;
        out.push({ key, kind: 'kpi', value: pct(missed, calls.length), hint: `${missed} of ${calls.length} calls` });
        break;
      }
      case 'emergency_calls':
        out.push({ key, kind: 'kpi', value: String(calls.filter((c) => c.is_emergency).length) });
        break;
      case 'jobs_completed':
        out.push({ key, kind: 'kpi', value: String(jobs.filter((j) => j.job_status === 'completed').length) });
        break;
      case 'revenue_collected': {
        const sum = jobs.filter((j) => j.invoice_status === 'paid').reduce((s, j) => s + (j.invoice_amount ?? 0), 0);
        out.push({ key, kind: 'kpi', value: formatMoney(sum) });
        break;
      }
      case 'lead_conversion': {
        const won = leads.filter((l) => l.stage === 'won').length;
        out.push({ key, kind: 'kpi', value: pct(won, leads.length), hint: `${won} of ${leads.length} leads` });
        break;
      }
      case 'positive_sentiment': {
        const rated = calls.filter((c) => c.sentiment);
        const positive = rated.filter((c) => c.sentiment === 'positive').length;
        out.push({ key, kind: 'kpi', value: pct(positive, rated.length), hint: `${rated.length} rated calls` });
        break;
      }
      case 'call_volume_trend': {
        const step = period.days <= 31 ? 1 : 7;
        const buckets = Math.ceil(period.days / step);
        const counts = new Array<number>(buckets).fill(0);
        for (const c of calls) {
          const i = Math.floor((new Date(c.call_datetime).getTime() - period.startMs) / (step * DAY));
          if (i >= 0 && i < buckets) counts[i] += 1;
        }
        out.push({
          key,
          kind: 'series',
          points: counts.map((value, i) => ({ label: bucketLabel(period.startMs + i * step * DAY), value })),
        });
        break;
      }
      case 'lead_sources': {
        const map = new Map<string, { total: number; booked: number }>();
        for (const c of calls) {
          const src = titleCase(c.lead_source || 'unknown');
          const cur = map.get(src) ?? { total: 0, booked: 0 };
          cur.total += 1;
          if (c.status === 'booked') cur.booked += 1;
          map.set(src, cur);
        }
        const rows = [...map.entries()]
          .sort((a, b) => b[1].booked - a[1].booked || b[1].total - a[1].total || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([src, v]) => [src, String(v.total), String(v.booked), pct(v.booked, v.total)]);
        out.push({ key, kind: 'table', columns: ['Source', 'Calls', 'Booked', 'Rate'], rows });
        break;
      }
      case 'call_outcomes': {
        const map = new Map<string, number>();
        for (const c of calls) {
          const s = titleCase(c.status || 'unknown');
          map.set(s, (map.get(s) ?? 0) + 1);
        }
        const rows = [...map.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 10)
          .map(([s, n]) => [s, String(n), pct(n, calls.length)]);
        out.push({ key, kind: 'table', columns: ['Outcome', 'Calls', 'Share'], rows });
        break;
      }
    }
  }
  return out;
}

export function buildPayload(source: SnapshotSource, keys: WidgetKey[], period: Period, nowMs: number = Date.now()): SnapshotPayload {
  return {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    period: { start: new Date(period.startMs).toISOString(), end: new Date(period.endMs - 1).toISOString(), days: period.days },
    widgets: computeWidgets(source, keys, period),
  };
}

/* ------------------------------ validation ------------------------------- */

export interface SnapshotOptions {
  title: string;
  audience: string;
  periodDays: number;
  expiryDays: number;
  widgetKeys: WidgetKey[];
}

export function validateOptions(input: {
  title: string;
  audience: string;
  periodDays: number;
  expiryDays: number;
  widgetKeys: string[];
}): { ok: true; value: SnapshotOptions } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const title = input.title.trim();
  const audience = input.audience.trim();
  if (title.length < 1 || title.length > 80) errors.push('Title must be 1–80 characters.');
  if (audience.length > 80) errors.push('Recipient label must be 80 characters or fewer.');
  if (!(PERIOD_OPTIONS as readonly number[]).includes(input.periodDays)) errors.push('Choose a valid reporting period.');
  if (!Number.isInteger(input.expiryDays) || input.expiryDays < 1 || input.expiryDays > 90) errors.push('Expiry must be 1–90 days.');
  const keys = [...new Set(input.widgetKeys)].filter((k): k is WidgetKey => WIDGET_BY_KEY.has(k));
  if (keys.length === 0) errors.push('Select at least one widget.');
  if (keys.length !== new Set(input.widgetKeys).size) errors.push('Unknown widget selected.');
  if (errors.length) return { ok: false, errors };
  // Keep catalog order so every snapshot reads consistently.
  const ordered = WIDGET_CATALOG.map((w) => w.key).filter((k) => keys.includes(k));
  return { ok: true, value: { title, audience, periodDays: input.periodDays, expiryDays: input.expiryDays, widgetKeys: ordered } };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * The public page renders whatever the server returns, so treat it as
 * untrusted: validate the shape, drop unknown widgets, cap sizes.
 */
export function sanitizePayload(raw: unknown): SnapshotPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Array.isArray(r.widgets)) return null;
  const period = r.period as Record<string, unknown> | undefined;
  if (!period || typeof period.days !== 'number') return null;

  const widgets: WidgetData[] = [];
  for (const w of r.widgets.slice(0, 20)) {
    const wr = w as Record<string, unknown>;
    const def = WIDGET_BY_KEY.get(String(wr?.key));
    if (!def || wr.kind !== def.kind) continue;
    if (def.kind === 'kpi') {
      widgets.push({ key: def.key, kind: 'kpi', value: str(wr.value, 40), hint: wr.hint ? str(wr.hint, 80) : undefined });
    } else if (def.kind === 'series' && Array.isArray(wr.points)) {
      const points = wr.points
        .slice(0, 120)
        .map((p) => ({ label: str((p as Record<string, unknown>)?.label, 20), value: Number((p as Record<string, unknown>)?.value) }))
        .filter((p) => Number.isFinite(p.value) && p.value >= 0);
      widgets.push({ key: def.key, kind: 'series', points });
    } else if (def.kind === 'table' && Array.isArray(wr.columns) && Array.isArray(wr.rows)) {
      const columns = wr.columns.slice(0, 6).map((c) => str(c, 30));
      const rows = wr.rows
        .slice(0, 50)
        .filter(Array.isArray)
        .map((row) => (row as unknown[]).slice(0, columns.length).map((c) => str(c, 60)));
      widgets.push({ key: def.key, kind: 'table', columns, rows });
    }
  }
  return {
    version: 1,
    generatedAt: str(r.generatedAt, 40),
    period: { start: str(period.start, 40), end: str(period.end, 40), days: Math.max(1, Math.min(366, Math.round(period.days))) },
    widgets,
  };
}

/* ------------------------------ link & status ----------------------------- */

export type SnapshotStatus = 'active' | 'expired' | 'revoked';

export function snapshotStatus(s: { expires_at: string; revoked_at: string | null }, nowMs: number = Date.now()): SnapshotStatus {
  if (s.revoked_at) return 'revoked';
  return new Date(s.expires_at).getTime() <= nowMs ? 'expired' : 'active';
}

/** Tokens are 64 lowercase hex chars (two random UUIDs, server-generated). */
export function isValidShareToken(token: string | undefined | null): token is string {
  return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);
}

export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/shared/dashboard/${token}`;
}

export function expiryLabel(expiresAt: string, nowMs: number = Date.now()): string {
  const diff = new Date(expiresAt).getTime() - nowMs;
  const abs = Math.abs(diff);
  const text = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))}m` : abs < 2 * DAY ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / DAY)}d`;
  return diff > 0 ? `Expires in ${text}` : `Expired ${text} ago`;
}

export function snapshotFilename(title: string, nowMs: number = Date.now()): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dashboard';
  return `${slug}-${new Date(nowMs).toISOString().slice(0, 10)}.pdf`;
}

export function widgetTitle(key: string): string {
  return WIDGET_BY_KEY.get(key)?.title ?? key;
}
