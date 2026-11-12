// supabase/functions/_shared/usage-alerts/sweep.ts
// Keyset-paginated sweep over account owners. Pure orchestration over ports (unit-tested with fakes).

import { buildMinutesAlert, type AlertAccount } from "./copy.ts";
import {
  effectiveIncludedMinutes, isAlertableAccount, planMinutesAlerts, usagePeriodKey, usageThresholdsReached,
  type MinutesKind, type UsageAlertKind,
} from "./core.ts";
import { deliverAlert, recordSuperseded, type AlertPorts } from "./dispatch.ts";

export interface SweepAccount extends AlertAccount {
  bonus_minutes?: number | null;
}

export interface SweepPorts extends AlertPorts {
  /** Owners with id > afterId, ordered by id ascending, at most `limit` rows. */
  fetchPage(afterId: string | null, limit: number): Promise<SweepAccount[]>;
  /** Kinds already completed this period for these users. */
  loadCompleted(periodKey: string, userIds: string[]): Promise<Map<string, Set<string>>>;
}

export interface SweepOptions {
  now: Date;
  siteUrl: string;
  mode: "live" | "shadow";
  pageSize?: number;
  concurrency?: number;
  budgetMs?: number;
  clock?: () => number;
}

export interface SweepSummary {
  mode: "live" | "shadow";
  period_key: string;
  pages: number;
  scanned: number;
  candidates: number;
  sent: Partial<Record<MinutesKind, number>>;
  would_send: Partial<Record<MinutesKind, number>>;
  superseded: number;
  partial: number;
  not_claimed: number;
  errors: number;
  truncated: boolean;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export async function runUsageAlertSweep(ports: SweepPorts, opts: SweepOptions): Promise<SweepSummary> {
  const pageSize = opts.pageSize ?? 1000;
  const clock = opts.clock ?? (() => Date.now());
  const startedAt = clock();
  const periodKey = usagePeriodKey(opts.now);
  const s: SweepSummary = {
    mode: opts.mode, period_key: periodKey, pages: 0, scanned: 0, candidates: 0,
    sent: {}, would_send: {}, superseded: 0, partial: 0, not_claimed: 0, errors: 0, truncated: false,
  };

  let cursor: string | null = null;
  for (;;) {
    if (clock() - startedAt > (opts.budgetMs ?? 110_000)) { s.truncated = true; break; }
    const page = await ports.fetchPage(cursor, pageSize);
    if (page.length === 0) break; // never stop on a short page: PostgREST max-rows may be below pageSize
    s.pages++;
    s.scanned += page.length;
    cursor = page[page.length - 1].id;

    const due = page
      .filter(isAlertableAccount)
      .map((a) => ({ a, reached: usageThresholdsReached(a.minutes_used_this_month, effectiveIncludedMinutes(a)) }))
      .filter((x) => x.reached.length > 0);
    s.candidates += due.length;
    if (due.length === 0) continue;

    const completed = await ports.loadCompleted(periodKey, due.map((x) => x.a.id));

    await pool(due, opts.concurrency ?? 5, async ({ a, reached }) => {
      const plan = planMinutesAlerts(reached, completed.get(a.id) ?? new Set<string>());
      if (opts.mode === "shadow") {
        for (const k of plan.send) s.would_send[k] = (s.would_send[k] ?? 0) + 1;
        return;
      }
      try {
        for (const k of plan.superseded) if (await recordSuperseded(ports, a.id, k, periodKey)) s.superseded++;
        for (const k of plan.send) {
          const acct: AlertAccount = { ...a, minutes_included: effectiveIncludedMinutes(a) };
          const res = await deliverAlert(ports, acct, k as UsageAlertKind, buildMinutesAlert(k, acct, periodKey), { periodKey, siteUrl: opts.siteUrl });
          if (res.status === "not_claimed") s.not_claimed++;
          else if (res.status === "partial") s.partial++;
          else s.sent[k] = (s.sent[k] ?? 0) + 1;
        }
      } catch {
        s.errors++; // one account never aborts the run; its lease expires and the next run retries
      }
    });
  }
  return s;
}
