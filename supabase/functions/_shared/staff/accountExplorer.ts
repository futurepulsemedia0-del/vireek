// supabase/functions/_shared/staff/accountExplorer.ts
//
// Account health scoring + impersonation request rules for the internal
// /staff/customers explorer. Pure and deterministic: NO imports, NO I/O.
//
// Shared by:
//   - the staff UI (src/lib/staffCustomers.ts re-exports it)
//   - the staff-impersonate edge function (the SAME validation runs server-side,
//     so the UI can never be a looser gate than the API)
//   - unit tests
//
// Health score = 100 points across six explainable factors. The engine never
// invents data: every factor reports the exact numbers it used, so a support
// agent can see WHY an account scored what it did.

export type HealthBand = 'healthy' | 'watch' | 'at_risk' | 'critical' | 'new' | 'churned';

export interface AccountSignals {
  id: string;
  status: 'active' | 'suspended' | 'canceled';
  subscriptionStatus: 'active' | 'past_due' | 'suspended';
  dunningStage: number;
  onboardingCompleted: boolean;
  minutesUsed: number;
  minutesIncluded: number;
  createdAt: string;
  lastSignInAt: string | null;
  lastCallAt: string | null;
  calls30d: number;
  callsPrev30d: number;
  bookings30d: number;
  teamCount: number;
  numbersCount: number;
}

export interface HealthFactor {
  key: 'activation' | 'recency' | 'trend' | 'value' | 'billing' | 'usage';
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface HealthResult {
  score: number;
  band: HealthBand;
  factors: HealthFactor[];
}

export const BAND_LABELS: Record<HealthBand, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At risk',
  critical: 'Critical',
  new: 'New',
  churned: 'Churned',
};

/** Lower rank = needs attention sooner. Used for the default "worst first" sort. */
export const BAND_RANK: Record<HealthBand, number> = { critical: 0, at_risk: 1, watch: 2, new: 3, healthy: 4, churned: 5 };

const DAY_MS = 86_400_000;
const NEW_ACCOUNT_DAYS = 7;

export function daysBetween(fromIso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / DAY_MS));
}

export function computeHealth(s: AccountSignals, now: Date = new Date()): HealthResult {
  const ageDays = daysBetween(s.createdAt, now);
  const isNew = ageDays < NEW_ACCOUNT_DAYS;
  const factors: HealthFactor[] = [];

  // 1. Activation (15) — is the product actually set up?
  const act = (s.onboardingCompleted ? 5 : 0) + (s.numbersCount > 0 ? 6 : 0) + (s.teamCount > 0 ? 4 : 0);
  factors.push({
    key: 'activation',
    label: 'Activation',
    points: act,
    max: 15,
    detail: `Onboarding ${s.onboardingCompleted ? 'done' : 'not finished'} · ${s.numbersCount} number${s.numbersCount === 1 ? '' : 's'} · ${s.teamCount} team member${s.teamCount === 1 ? '' : 's'}`,
  });

  // 2. Recency (25) — when did the AI last take a call?
  let recency = 0;
  let recencyDetail: string;
  if (!s.lastCallAt) {
    recency = isNew ? 12 : 0;
    recencyDetail = isNew ? 'No calls yet (account is new)' : 'No calls on record';
  } else {
    const d = daysBetween(s.lastCallAt, now);
    recency = d <= 3 ? 25 : d <= 7 ? 20 : d <= 14 ? 12 : d <= 30 ? 5 : 0;
    recencyDetail = d === 0 ? 'Last call today' : `Last call ${d} day${d === 1 ? '' : 's'} ago`;
  }
  factors.push({ key: 'recency', label: 'Recent activity', points: recency, max: 25, detail: recencyDetail });

  // 3. Volume trend (20) — is usage growing or fading?
  let trend: number;
  let trendDetail: string;
  if (s.calls30d === 0) {
    trend = isNew ? 10 : 0;
    trendDetail = isNew ? 'No calls yet (account is new)' : 'No calls in the last 30 days';
  } else if (s.callsPrev30d === 0) {
    trend = 20;
    trendDetail = `${s.calls30d} calls, up from none the month before`;
  } else {
    const ratio = s.calls30d / s.callsPrev30d;
    trend = ratio >= 1 ? 20 : ratio >= 0.75 ? 15 : ratio >= 0.5 ? 8 : 3;
    trendDetail = `${s.calls30d} calls vs ${s.callsPrev30d} the month before (${Math.round((ratio - 1) * 100)}%)`;
  }
  factors.push({ key: 'trend', label: 'Call volume trend', points: trend, max: 20, detail: trendDetail });

  // 4. Value realized (15) — are calls turning into booked work?
  let value: number;
  let valueDetail: string;
  if (s.calls30d < 5) {
    value = 8;
    valueDetail = 'Too few calls to judge (neutral)';
  } else {
    const rate = s.bookings30d / s.calls30d;
    value = rate >= 0.25 ? 15 : rate >= 0.1 ? 10 : rate > 0 ? 5 : 0;
    valueDetail = `${s.bookings30d} of ${s.calls30d} calls booked (${Math.round(rate * 100)}%)`;
  }
  factors.push({ key: 'value', label: 'Bookings', points: value, max: 15, detail: valueDetail });

  // 5. Billing (15)
  let billing = 0;
  let billingDetail: string;
  if (s.subscriptionStatus === 'active' && s.dunningStage === 0) {
    billing = 15;
    billingDetail = 'Subscription active, no payment issues';
  } else if (s.subscriptionStatus === 'past_due') {
    billing = 4;
    billingDetail = `Payment past due (dunning stage ${s.dunningStage})`;
  } else if (s.subscriptionStatus === 'active') {
    billing = 9;
    billingDetail = `Active, but in dunning stage ${s.dunningStage}`;
  } else {
    billingDetail = 'Subscription suspended';
  }
  factors.push({ key: 'billing', label: 'Billing', points: billing, max: 15, detail: billingDetail });

  // 6. Usage fit (10) — minutes used vs included
  let usage: number;
  let usageDetail: string;
  if (s.minutesIncluded <= 0) {
    usage = 5;
    usageDetail = 'No included minutes on this plan';
  } else {
    const pct = s.minutesUsed / s.minutesIncluded;
    usage = pct > 1 ? 6 : pct >= 0.2 ? 10 : 4;
    usageDetail = `${Math.round(s.minutesUsed)} of ${s.minutesIncluded} minutes (${Math.round(pct * 100)}%)${pct > 1 ? ' — over plan' : pct < 0.2 ? ' — barely using the plan' : ''}`;
  }
  factors.push({ key: 'usage', label: 'Plan usage', points: usage, max: 10, detail: usageDetail });

  const score = Math.min(100, factors.reduce((sum, f) => sum + f.points, 0));
  if (s.status === 'canceled') return { score: 0, band: 'churned', factors };
  const band: HealthBand = isNew && !s.lastCallAt ? 'new' : score >= 75 ? 'healthy' : score >= 50 ? 'watch' : score >= 25 ? 'at_risk' : 'critical';
  return { score: s.status === 'suspended' ? Math.min(score, 20) : score, band: s.status === 'suspended' ? 'critical' : band, factors };
}

// ---------------------------------------------------------------------------
// Impersonation rules (enforced in the UI AND in the edge function)
// ---------------------------------------------------------------------------

export const REASON_MIN = 15;
export const REASON_MAX = 500;
export const IMPERSONATION_MINUTES = 30;
export const IMPERSONATION_MAX_PER_HOUR = 10;
const TICKET_REF = /^[A-Za-z0-9][A-Za-z0-9#_\-]{1,39}$/;

export interface ImpersonationRequest {
  reason: string;
  ticketRef?: string | null;
}

export function validateImpersonationRequest(req: ImpersonationRequest): string[] {
  const errors: string[] = [];
  const reason = (req.reason ?? '').trim();
  if (reason.length < REASON_MIN) errors.push(`Explain why you need access (at least ${REASON_MIN} characters).`);
  if (reason.length > REASON_MAX) errors.push(`Reason is limited to ${REASON_MAX} characters.`);
  const ticket = (req.ticketRef ?? '').trim();
  if (ticket && !TICKET_REF.test(ticket)) errors.push('Ticket reference may only contain letters, numbers, #, - and _ (2–40 characters).');
  return errors;
}

/** Returns a human-readable denial, or null when impersonation is allowed. */
export function impersonationDenial(target: { id: string; isStaff: boolean }, staffId: string): string | null {
  if (target.id === staffId) return 'You cannot sign in as yourself.';
  if (target.isStaff) return 'Staff accounts cannot be impersonated.';
  return null;
}

// ---------------------------------------------------------------------------
// List helpers (client-side search / filter / sort over the account overview)
// ---------------------------------------------------------------------------

export interface ExplorerRow {
  id: string;
  companyName: string | null;
  fullName: string | null;
  email: string;
  health: HealthResult;
  calls30d: number;
  createdAt: string;
  lastCallAt: string | null;
}

export type ExplorerSort = 'attention' | 'health_desc' | 'newest' | 'calls_desc' | 'last_call';

export function filterAndSortRows(rows: ExplorerRow[], opts: { search: string; band: HealthBand | 'all'; sort: ExplorerSort }): ExplorerRow[] {
  const q = opts.search.trim().toLowerCase();
  const out = rows.filter((r) => {
    if (opts.band !== 'all' && r.health.band !== opts.band) return false;
    if (!q) return true;
    return [r.companyName, r.fullName, r.email, r.id].some((v) => (v ?? '').toLowerCase().includes(q));
  });
  const byName = (a: ExplorerRow, b: ExplorerRow) => (a.companyName ?? a.email).localeCompare(b.companyName ?? b.email);
  const time = (iso: string | null) => (iso ? Date.parse(iso) : 0);
  const cmp: Record<ExplorerSort, (a: ExplorerRow, b: ExplorerRow) => number> = {
    attention: (a, b) => BAND_RANK[a.health.band] - BAND_RANK[b.health.band] || a.health.score - b.health.score || byName(a, b),
    health_desc: (a, b) => b.health.score - a.health.score || byName(a, b),
    newest: (a, b) => time(b.createdAt) - time(a.createdAt),
    calls_desc: (a, b) => b.calls30d - a.calls30d || byName(a, b),
    last_call: (a, b) => time(b.lastCallAt) - time(a.lastCallAt),
  };
  return out.sort(cmp[opts.sort]);
}

export function maskPhone(phone: string | null): string {
  if (!phone) return 'Unknown';
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}
