// supabase/functions/_shared/analytics/founderKpis.ts
//
// PART B - PLATFORM-STAFF FOUNDER KPIs. Pure and deterministic: no network, no database, no
// Deno/DOM APIs. Imported by the `founder-kpis` edge function and the staff page, and locked by
// founderKpis.test.ts. Every definition below is mirrored in docs/ANALYTICS_METRICS.md.
//
// ---------------------------------------------------------------------------------------------
// DATA MODEL
//   The MRR ledger is a list of STATE CHANGES per account: "from `at` onwards this account's MRR is
//   `mrrCents`" (0 = not subscribed / churned). It is produced by the subscription_mrr_events table
//   (derived from Stripe subscription events in billing_events). All money is integer USD cents.
//
// SNAPSHOT CONVENTION (the single rule that makes periods add up)
//   snapshot(T) = the MRR state produced by all ledger points with `at` STRICTLY BEFORE T.
//   A period is [start, end). Start snapshot = snapshot(start); end snapshot = snapshot(end).
//   An event exactly at `start` therefore belongs to the period, and end(month m) === start(month m+1).
//
// DEFINITIONS (basis points = integer, 10000 = 100%; null = "no data", never a fake 0)
//   starting cohort   accounts with snapshot(start) > 0. New logos acquired inside the period are NOT in it.
//   GRR (gross dollar retention)
//                     sum over cohort of min(end_i, start_i) / sum(start_i). Expansion never counts, so
//                     GRR is always within 0..10000. A churned account contributes 0.
//   NRR (net revenue retention)
//                     sum over cohort of end_i / sum(start_i). Includes expansion, contraction and churn;
//                     excludes new logos and reactivations of accounts that were churned at `start`.
//   Net-of-period     Upgrades/downgrades inside the period are measured point-to-point: an upgrade then a
//                     downgrade back inside the same month is invisible (net zero), by design.
//   Churn within month
//                     An account that starts AND churns inside the same period never appears in the
//                     cohort or in new MRR (start=0, end=0). It is counted in `intraPeriodChurnAccounts`
//                     for transparency only.
//   New MRR           sum(end_i) for accounts with snapshot(start) = 0 and snapshot(end) > 0
//                     (new logos AND reactivations; reactivationAccounts counts the latter).
//   Activation        share of signups in the window that reached their activation event within
//                     `windowDays` of signup. Only MATURE signups (signup + windowDays <= asOf) are in the
//                     denominator, so a young cohort cannot drag the rate down.
//   Module attach     distinct PAYING accounts using a module / PAYING accounts. Usage by free or
//                     churned accounts is ignored.
//   Payment take rate platform fee revenue / gross payment volume (card volume processed through Vireek).
//   CAC               manual sales+marketing spend / new customers (new logos only).
//   CAC payback       CAC / (average new-customer MRR x gross margin). Months. null if any divisor <= 0.
//   Cohort table      cohort month = month of an account's first positive ledger point. Initial MRR =
//                     snapshot at the END of the cohort month (so same-month upgrades count and same-month
//                     churn drops the account). Cell k = snapshot at the end of cohort month + k; a cell is
//                     null until that month has fully elapsed (asOf).

export interface MrrPoint {
  accountId: string;
  /** ISO timestamp from which `mrrCents` applies. */
  at: string;
  /** MRR in integer cents after the change; 0 means not subscribed. */
  mrrCents: number;
}

interface Step { t: number; mrr: number }
export type Ledger = Map<string, Step[]>;

export interface LedgerStats { accepted: number; rejected: number }

/** Validates, sorts (stable) and groups the ledger. Invalid rows are dropped and counted, never guessed. */
export function buildLedger(points: readonly MrrPoint[]): { ledger: Ledger; stats: LedgerStats } {
  const ledger: Ledger = new Map();
  let accepted = 0;
  let rejected = 0;
  points.forEach((p, i) => {
    const t = Date.parse(p?.at);
    const ok = !!p && typeof p.accountId === "string" && p.accountId.length > 0 && Number.isFinite(t) &&
      Number.isFinite(p.mrrCents) && Number.isInteger(p.mrrCents) && p.mrrCents >= 0;
    if (!ok) { rejected++; return; }
    accepted++;
    const arr = ledger.get(p.accountId) ?? [];
    // index is kept implicitly by push order; sort below is stable so equal timestamps keep input order
    arr.push({ t, mrr: p.mrrCents });
    ledger.set(p.accountId, arr);
    void i;
  });
  for (const arr of ledger.values()) arr.sort((a, b) => a.t - b.t);
  return { ledger, stats: { accepted, rejected } };
}

/** MRR state of one account at instant T: the last step strictly before T (0 if none). */
export function snapshot(steps: readonly Step[] | undefined, T: number): number {
  if (!steps || steps.length === 0) return 0;
  let lo = 0;
  let hi = steps.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].t < T) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans === -1 ? 0 : steps[ans].mrr;
}

/** Integer basis points of a/b, rounded half up; null when b <= 0. */
export function bp(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.round((a * 10000) / b);
}

export interface RetentionResult {
  startMrrCents: number;
  endMrrFromCohortCents: number;
  retainedGrossCents: number;
  churnedCents: number;
  contractionCents: number;
  expansionCents: number;
  newMrrCents: number;
  cohortAccounts: number;
  churnedAccounts: number;
  newAccounts: number;
  reactivationAccounts: number;
  intraPeriodChurnAccounts: number;
  grrBp: number | null;
  nrrBp: number | null;
  /** Closing MRR of everyone (cohort + new). Equals start + new + expansion - contraction - churn. */
  closingMrrCents: number;
}

export function computeRetention(ledger: Ledger, startIso: string, endIso: string): RetentionResult {
  const T0 = Date.parse(startIso);
  const T1 = Date.parse(endIso);
  if (!Number.isFinite(T0) || !Number.isFinite(T1) || T1 <= T0) throw new Error("Invalid period: end must be after start.");
  const r: RetentionResult = {
    startMrrCents: 0, endMrrFromCohortCents: 0, retainedGrossCents: 0, churnedCents: 0, contractionCents: 0,
    expansionCents: 0, newMrrCents: 0, cohortAccounts: 0, churnedAccounts: 0, newAccounts: 0,
    reactivationAccounts: 0, intraPeriodChurnAccounts: 0, grrBp: null, nrrBp: null, closingMrrCents: 0,
  };
  for (const steps of ledger.values()) {
    const s = snapshot(steps, T0);
    const e = snapshot(steps, T1);
    r.closingMrrCents += e;
    if (s > 0) {
      r.cohortAccounts++;
      r.startMrrCents += s;
      r.endMrrFromCohortCents += e;
      r.retainedGrossCents += Math.min(s, e);
      if (e === 0) { r.churnedCents += s; r.churnedAccounts++; }
      else if (e < s) r.contractionCents += s - e;
      else if (e > s) r.expansionCents += e - s;
    } else if (e > 0) {
      r.newMrrCents += e;
      r.newAccounts++;
      // Reactivation = had a positive state strictly before the period start.
      if (steps.some((x) => x.t < T0 && x.mrr > 0)) r.reactivationAccounts++;
    } else if (steps.some((x) => x.t >= T0 && x.t < T1 && x.mrr > 0)) {
      r.intraPeriodChurnAccounts++;
    }
  }
  r.grrBp = bp(r.retainedGrossCents, r.startMrrCents);
  r.nrrBp = bp(r.endMrrFromCohortCents, r.startMrrCents);
  return r;
}

// ------------------------------------------------------------------ months & cohorts

/** "2028-03" -> [start, end) as ISO strings in UTC. */
export function monthBounds(ym: string): { start: string; end: string } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  if (!m) throw new Error(`Invalid month: ${ym}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(Date.UTC(y, mo, 1)).toISOString(), end: new Date(Date.UTC(y, mo + 1, 1)).toISOString() };
}

export function addMonths(ym: string, n: number): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  if (!m) throw new Error(`Invalid month: ${ym}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const monthOf = (t: number): string => new Date(t).toISOString().slice(0, 7);

export interface CohortCell {
  offset: number;
  activeAccounts: number | null;
  netMrrCents: number | null;
  nrrBp: number | null;
  logoRetentionBp: number | null;
}
export interface CohortRow { cohort: string; accounts: number; initialMrrCents: number; cells: CohortCell[] }

export function computeCohortTable(
  ledger: Ledger, fromMonth: string, toMonth: string, maxOffset: number, asOfIso: string,
): CohortRow[] {
  const asOf = Date.parse(asOfIso);
  if (!Number.isFinite(asOf)) throw new Error("Invalid asOf.");
  const offsets = Math.max(0, Math.min(36, Math.trunc(maxOffset)));
  // first positive point per account -> cohort month
  const cohortOf = new Map<string, string>();
  for (const [id, steps] of ledger) {
    const first = steps.find((x) => x.mrr > 0);
    if (first) cohortOf.set(id, monthOf(first.t));
  }
  const rows: CohortRow[] = [];
  for (let c = fromMonth; c <= toMonth; c = addMonths(c, 1)) {
    const endC = Date.parse(monthBounds(c).end);
    const members = [...cohortOf].filter(([, m]) => m === c).map(([id]) => id);
    // initial = end of the cohort month; accounts at 0 then are dropped (churn within month).
    const live = members.filter((id) => snapshot(ledger.get(id), endC) > 0);
    const initial = live.reduce((s, id) => s + snapshot(ledger.get(id), endC), 0);
    const cells: CohortCell[] = [];
    for (let k = 0; k <= offsets; k++) {
      const endK = Date.parse(monthBounds(addMonths(c, k)).end);
      if (endK > asOf || live.length === 0) {
        cells.push({ offset: k, activeAccounts: null, netMrrCents: null, nrrBp: null, logoRetentionBp: null });
        continue;
      }
      let net = 0;
      let active = 0;
      for (const id of live) {
        const v = snapshot(ledger.get(id), endK);
        net += v;
        if (v > 0) active++;
      }
      cells.push({ offset: k, activeAccounts: active, netMrrCents: net, nrrBp: bp(net, initial), logoRetentionBp: bp(active, live.length) });
    }
    rows.push({ cohort: c, accounts: live.length, initialMrrCents: initial, cells });
  }
  return rows;
}

// ------------------------------------------------------------------ activation, attach, take rate, CAC

export interface SignupRow { accountId: string; createdAt: string; activatedAt: string | null }
export interface ActivationResult { signups: number; matured: number; immature: number; activated: number; rateBp: number | null }

const DAY = 86_400_000;

export function computeActivation(
  signups: readonly SignupRow[], windowDays: number, asOfIso: string, fromIso: string, toIso: string,
): ActivationResult {
  const asOf = Date.parse(asOfIso);
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (![asOf, from, to].every(Number.isFinite) || to <= from) throw new Error("Invalid activation window.");
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) throw new Error("windowDays must be 1..90.");
  let total = 0;
  let matured = 0;
  let activated = 0;
  for (const s of signups) {
    const c = Date.parse(s.createdAt);
    if (!Number.isFinite(c) || c < from || c >= to) continue;
    total++;
    if (c + windowDays * DAY > asOf) continue;
    matured++;
    const a = s.activatedAt ? Date.parse(s.activatedAt) : NaN;
    if (Number.isFinite(a) && a - c <= windowDays * DAY) activated++;
  }
  return { signups: total, matured, immature: total - matured, activated, rateBp: bp(activated, matured) };
}

export interface AttachRow { moduleKey: string; attachedAccounts: number; payingAccounts: number; rateBp: number | null }

export function computeAttachRates(
  payingAccountIds: readonly string[], usage: readonly { accountId: string; moduleKey: string }[], modules: readonly string[],
): AttachRow[] {
  const paying = new Set(payingAccountIds);
  return modules.map((moduleKey) => {
    const users = new Set<string>();
    for (const u of usage) if (u.moduleKey === moduleKey && paying.has(u.accountId)) users.add(u.accountId);
    return { moduleKey, attachedAccounts: users.size, payingAccounts: paying.size, rateBp: bp(users.size, paying.size) };
  });
}

export function computeTakeRate(grossPaymentVolumeCents: number, platformFeeCents: number): { takeRateBp: number | null } {
  if (!Number.isFinite(platformFeeCents) || platformFeeCents < 0) throw new Error("platformFeeCents must be >= 0.");
  return { takeRateBp: bp(platformFeeCents, grossPaymentVolumeCents) };
}

export interface CacInput { spendCents: number; newCustomers: number; newMrrCents: number; grossMarginBp: number }
export interface CacResult { cacCents: number | null; avgNewMrrCents: number | null; paybackMonths: number | null }

export function computeCacPayback(i: CacInput): CacResult {
  if (![i.spendCents, i.newCustomers, i.newMrrCents, i.grossMarginBp].every(Number.isFinite) || i.spendCents < 0) {
    throw new Error("Invalid CAC inputs.");
  }
  if (i.grossMarginBp > 10000) throw new Error("grossMarginBp must be <= 10000.");
  if (i.newCustomers <= 0) return { cacCents: null, avgNewMrrCents: null, paybackMonths: null };
  const cac = i.spendCents / i.newCustomers;
  const avg = i.newMrrCents / i.newCustomers;
  const monthlyMargin = avg * (i.grossMarginBp / 10000);
  return {
    cacCents: Math.round(cac),
    avgNewMrrCents: Math.round(avg),
    paybackMonths: monthlyMargin > 0 ? Math.round((cac / monthlyMargin) * 100) / 100 : null,
  };
}

/** Accounts with MRR > 0 at instant T (same snapshot rule as everything else). */
export function activeAccountIds(ledger: Ledger, atIso: string): string[] {
  const T = Date.parse(atIso);
  if (!Number.isFinite(T)) throw new Error("Invalid instant.");
  const out: string[] = [];
  for (const [id, steps] of ledger) if (snapshot(steps, T) > 0) out.push(id);
  return out;
}
