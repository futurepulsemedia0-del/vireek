// Enterprise Trust Pack — SLA tracking + automatic service credits.
//
// ISOMORPHIC pure logic. Used by the dashboard (month-to-date uptime) AND by the
// `sla-credit-run` edge function (monthly credits) so both always agree.
//
// Rules mirror the public SLA (src/components/sections/SlaContent.tsx):
//   uptime % = (total minutes in month - Downtime minutes) / total minutes * 100
//   Downtime = confirmed core-platform outage within Vireek's control.
//   Excluded = degraded performance, announced maintenance (>= 24h notice),
//              third-party carrier/integration outages, force majeure.
//   Credit   = % of that month's subscription fee, by tier (defaults 10 / 25 / 50).

import type { RegionCode } from './regions.ts';

export const MINUTE_MS = 60_000;
export const MAINTENANCE_NOTICE_MS = 24 * 3_600_000;

export type IncidentKind = 'outage' | 'degraded' | 'maintenance' | 'third_party' | 'force_majeure';
export const INCIDENT_KINDS: readonly IncidentKind[] = ['outage', 'degraded', 'maintenance', 'third_party', 'force_majeure'];

export interface Incident {
  id: string;
  title: string;
  kind: IncidentKind;
  /** 'all' = every tenant; otherwise only tenants whose data plane region matches. */
  scope: 'all' | RegionCode;
  /** When set, the incident applies to this account only (dedicated-tenant outages). */
  tenant_id: string | null;
  started_at: string;
  ended_at: string | null;
  /** For kind = 'maintenance': when customers were told. */
  announced_at: string | null;
  /** Only confirmed incidents count (matches "confirmed by our monitoring systems"). */
  confirmed: boolean;
}

export interface SlaTier {
  /** Credit applies when uptime is strictly below this percentage. */
  below: number;
  credit_pct: number;
}

export const DEFAULT_SLA_TIERS: SlaTier[] = [
  { below: 99.9, credit_pct: 10 },
  { below: 99.0, credit_pct: 25 },
  { below: 95.0, credit_pct: 50 },
];

export interface SlaTenant {
  id: string;
  region: RegionCode;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const isPeriod = (v: unknown): v is string => typeof v === 'string' && PERIOD_RE.test(v);

export interface PeriodWindow {
  period: string;
  start: number;
  end: number;
  totalMinutes: number;
}

export function periodWindow(period: string): PeriodWindow {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`Invalid period "${period}" (expected YYYY-MM)`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const start = Date.UTC(y, mo, 1);
  const end = Date.UTC(y, mo + 1, 1);
  return { period, start, end, totalMinutes: (end - start) / MINUTE_MS };
}

export function periodOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function previousPeriod(nowMs: number): string {
  const d = new Date(nowMs);
  return periodOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

/** Customers have 30 days after month end to dispute — the SLA's claim window. */
export const CLAIM_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Downtime
// ---------------------------------------------------------------------------

export type ExclusionReason = 'not_confirmed' | 'degraded' | 'announced_maintenance' | 'third_party' | 'force_majeure' | 'not_your_region' | 'outside_period';

export interface IncidentVerdict {
  incident: Incident;
  counts: boolean;
  reason: ExclusionReason | null;
}

export function incidentApplies(i: Incident, tenant: SlaTenant): boolean {
  if (i.tenant_id) return i.tenant_id === tenant.id;
  return i.scope === 'all' || i.scope === tenant.region;
}

export function classifyIncident(i: Incident, tenant: SlaTenant): { counts: boolean; reason: ExclusionReason | null } {
  if (!incidentApplies(i, tenant)) return { counts: false, reason: 'not_your_region' };
  if (!i.confirmed) return { counts: false, reason: 'not_confirmed' };
  switch (i.kind) {
    case 'outage': return { counts: true, reason: null };
    case 'degraded': return { counts: false, reason: 'degraded' };
    case 'third_party': return { counts: false, reason: 'third_party' };
    case 'force_majeure': return { counts: false, reason: 'force_majeure' };
    case 'maintenance': {
      const announced = i.announced_at ? Date.parse(i.announced_at) : NaN;
      const started = Date.parse(i.started_at);
      // Excluded only when customers were told at least 24h ahead; otherwise it is downtime.
      return Number.isFinite(announced) && started - announced >= MAINTENANCE_NOTICE_MS
        ? { counts: false, reason: 'announced_maintenance' }
        : { counts: true, reason: null };
    }
  }
}

export interface Interval { start: number; end: number }

/** Union of overlapping intervals — two simultaneous incidents never double-count a minute. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

export interface MonthlyReport {
  period: string;
  /** 'in_progress' while the month is still running; credits are only issued for 'final'. */
  state: 'in_progress' | 'final';
  /** Minutes measured: the whole month when final, month-to-date otherwise. */
  measuredMinutes: number;
  downtimeMinutes: number;
  uptimePct: number;
  verdicts: IncidentVerdict[];
}

/** Floors (never rounds up) so 99.8999 can't display as a passing 99.900. */
export function floorTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}

export function computeMonthlyReport(period: string, tenant: SlaTenant, incidents: Incident[], nowMs: number): MonthlyReport {
  const w = periodWindow(period);
  const measuredEnd = Math.min(w.end, nowMs);
  const state: MonthlyReport['state'] = nowMs >= w.end ? 'final' : 'in_progress';

  const verdicts: IncidentVerdict[] = [];
  const counted: Interval[] = [];
  for (const incident of incidents) {
    const start = Date.parse(incident.started_at);
    const end = incident.ended_at ? Date.parse(incident.ended_at) : measuredEnd; // still open: runs until now / month end
    if (!Number.isFinite(start) || (incident.ended_at && !Number.isFinite(end))) continue;
    if (end <= w.start || start >= measuredEnd) {
      // Not in this window at all — don't clutter the report.
      continue;
    }
    const { counts, reason } = classifyIncident(incident, tenant);
    verdicts.push({ incident, counts, reason });
    if (counts) counted.push({ start: Math.max(start, w.start), end: Math.min(end, measuredEnd) });
  }

  const downtimeMs = mergeIntervals(counted).reduce((s, i) => s + (i.end - i.start), 0);
  const measuredMs = Math.max(measuredEnd - w.start, 0);
  const uptimePct = measuredMs === 0 ? 100 : ((measuredMs - downtimeMs) / measuredMs) * 100;

  return {
    period,
    state,
    measuredMinutes: measuredMs / MINUTE_MS,
    downtimeMinutes: downtimeMs / MINUTE_MS,
    uptimePct,
    verdicts,
  };
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export function validateTiers(tiers: unknown): tiers is SlaTier[] {
  if (!Array.isArray(tiers) || tiers.length === 0 || tiers.length > 6) return false;
  const ok = tiers.every((t) => t && typeof t.below === 'number' && typeof t.credit_pct === 'number'
    && t.below > 0 && t.below <= 100 && t.credit_pct > 0 && t.credit_pct <= 100);
  if (!ok) return false;
  // Lower uptime must never earn a smaller credit.
  const byBelow = [...(tiers as SlaTier[])].sort((a, b) => b.below - a.below);
  for (let i = 1; i < byBelow.length; i++) {
    if (byBelow[i].below === byBelow[i - 1].below) return false;
    if (byBelow[i].credit_pct < byBelow[i - 1].credit_pct) return false;
  }
  return true;
}

export function creditPctFor(uptimePct: number, tiers: SlaTier[]): number {
  let pct = 0;
  for (const t of tiers) if (uptimePct < t.below && t.credit_pct > pct) pct = t.credit_pct;
  return pct;
}

export interface CreditQuote {
  creditPct: number;
  creditCents: number;
}

export function quoteCredit(uptimePct: number, tiers: SlaTier[], monthlyFeeCents: number | null): CreditQuote {
  const creditPct = creditPctFor(uptimePct, tiers);
  if (!monthlyFeeCents || monthlyFeeCents <= 0 || creditPct === 0) return { creditPct, creditCents: 0 };
  return { creditPct, creditCents: Math.min(monthlyFeeCents, Math.round((monthlyFeeCents * creditPct) / 100)) };
}

export function formatUptime(pct: number): string {
  return `${floorTo(pct, 3).toFixed(3)}%`;
}

export function formatMinutes(min: number): string {
  if (min < 1) return min === 0 ? '0 min' : '<1 min';
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export const EXCLUSION_LABEL: Record<ExclusionReason, string> = {
  not_confirmed: 'Not yet confirmed',
  degraded: 'Degraded performance (still answering calls)',
  announced_maintenance: 'Scheduled maintenance announced 24h+ ahead',
  third_party: 'Third-party carrier / integration outage',
  force_majeure: 'Force majeure',
  not_your_region: 'Did not affect your region',
  outside_period: 'Outside this month',
};
