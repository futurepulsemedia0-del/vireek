// supabase/functions/_shared/observability/alertRunner.ts
//
// One alert cycle with every side effect behind a port, so the full pipeline
// (metrics -> rules -> state machine -> grouping/budget -> delivery -> status page) is tested on synthetic data.
// Real-traffic burn-rate SLOs reuse the EXISTING math in synthetic/slo.ts (no second implementation).

import { evaluateBurnAlerts, shouldResolve, type BurnRule, type Counts } from "../synthetic/slo.ts";
import {
  DEFAULT_RULES, EMPTY_STATE, buildNotifications, evaluateRule, fingerprintOf, statusCopy,
  type AlertRule, type AlertState, type Decision, type MetricKey, type RoutedNotification, type Severity,
} from "./alertRules.ts";

export interface MetricRow { metric: MetricKey; scope_key: string; value: number | null; samples: number }
export interface SliCountRow { window_minutes: number; sli: string; good: number | string; total: number | string }
export interface Maintenance { scope_key: string; rule_key: string | null }

export interface RunnerPorts {
  now(): Date;
  loadMetrics(windowMinutes: number): Promise<MetricRow[]>;
  loadSliCounts(windows: number[]): Promise<SliCountRow[]>;
  loadStates(): Promise<Map<string, AlertState>>;
  saveState(fingerprint: string, ruleKey: string, scopeKey: string, state: AlertState): Promise<void>;
  loadMaintenance(): Promise<Maintenance[]>;
  pagesLastHour(): Promise<number>;
  /** Returns true when the provider accepted the notification. */
  deliver(n: RoutedNotification): Promise<boolean>;
  logDelivery(n: RoutedNotification, delivered: boolean): Promise<void>;
  openIncident(a: { dedupeKey: string; title: string; impact: "minor" | "major"; component: string; region: string | null; message: string }): Promise<void>;
  resolveIncident(a: { dedupeKey: string; message: string }): Promise<void>;
}

export const REAL_SLOS = [
  { key: "answer", label: "Calls answered by the AI receptionist", objective: 0.995, component: "voice-ai", runbook: "docs/runbooks/voice-answer-rate-drop.md" },
  { key: "booking", label: "Booking attempts that succeed", objective: 0.9, component: "crm-sync", runbook: "docs/runbooks/voice-tool-failures.md" },
] as const;

/** Real traffic is high-volume: stricter minimums than the synthetic defaults. */
export const REAL_BURN_RULES: BurnRule[] = [
  { impact: "major", longWindowMinutes: 60, shortWindowMinutes: 15, burn: 14.4, minBadLong: 5, minTotalShort: 20 },
  { impact: "minor", longWindowMinutes: 360, shortWindowMinutes: 60, burn: 6, minBadLong: 15, minTotalShort: 50 },
];

export interface CycleResult { evaluated: number; opened: number; resolved: number; renotified: number; delivered: number; deliveryFailures: number; notifications: RoutedNotification[] }

function scopesFor(rule: AlertRule, rows: MetricRow[], states: Map<string, AlertState>): string[] {
  const fromRows = rows.filter((r) => r.metric === rule.metric).map((r) => r.scope_key).filter((k) => (rule.scope === "global" ? k === "global" : rule.scope === "region" ? k !== "global" : true));
  const prefix = `obs:${rule.key}:`;
  const fromState = [...states.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  return [...new Set([...fromRows, ...fromState])];
}

export async function runAlertCycle(ports: RunnerPorts, rules: AlertRule[] = DEFAULT_RULES): Promise<CycleResult> {
  const now = ports.now();
  const [states, maint, pages] = await Promise.all([ports.loadStates(), ports.loadMaintenance(), ports.pagesLastHour()]);
  const maintenance = maint.flatMap((m) => (m.rule_key ? [m.rule_key] : [m.scope_key]));

  const windows = [...new Set(rules.map((r) => r.windowMinutes))];
  const byWindow = new Map<number, MetricRow[]>();
  await Promise.all(windows.map(async (w) => { byWindow.set(w, await ports.loadMetrics(w)); }));

  const decisions: Decision[] = [];
  for (const rule of rules) {
    const rows = byWindow.get(rule.windowMinutes) ?? [];
    for (const scopeKey of scopesFor(rule, rows, states)) {
      const row = rows.find((r) => r.metric === rule.metric && r.scope_key === scopeKey);
      const fp = fingerprintOf(rule.key, scopeKey);
      const d = evaluateRule(rule, { metric: rule.metric, scopeKey, value: row?.value ?? null, samples: Number(row?.samples ?? 0) }, states.get(fp) ?? { ...EMPTY_STATE }, { now, maintenance });
      decisions.push(d);
    }
  }

  // Burn-rate SLOs on real traffic (existing math from synthetic/slo.ts).
  const burnNotifications: RoutedNotification[] = [];
  const burnDecisions: Array<{ slo: (typeof REAL_SLOS)[number]; firing: boolean; impact: "minor" | "major" | null; resolve: boolean; fingerprint: string; prev: AlertState; shortBurn: number | null }> = [];
  const sliWindows = [...new Set([...REAL_BURN_RULES.flatMap((r) => [r.longWindowMinutes, r.shortWindowMinutes])])];
  const sliRows = await ports.loadSliCounts(sliWindows);
  for (const slo of REAL_SLOS) {
    const countsFor = (m: number): Counts => {
      const r = sliRows.find((x) => x.sli === slo.key && x.window_minutes === m);
      return { good: Number(r?.good ?? 0), total: Number(r?.total ?? 0) };
    };
    const fingerprint = `obs:burn:${slo.key}`;
    const prev = states.get(fingerprint) ?? { ...EMPTY_STATE };
    const dec = evaluateBurnAlerts(countsFor, slo.objective, REAL_BURN_RULES);
    const resolve = prev.phase === "firing" && !dec.firing && shouldResolve(countsFor(60), 20);
    burnDecisions.push({ slo, firing: dec.firing, impact: dec.impact, resolve, fingerprint, prev, shortBurn: dec.shortBurn });
  }

  const regular = buildNotifications(decisions, pages);
  let pagesUsed = pages + regular.filter((n) => n.channel === "pagerduty" && n.kind === "trigger").length;
  const maintAll = maintenance.includes("*");

  for (const b of burnDecisions) {
    const sev: Severity = b.impact === "major" ? "SEV2" : "SEV3";
    const synth = (kind: "trigger" | "resolve", summary: string): RoutedNotification => ({
      channel: sev === "SEV2" && pagesUsed < 6 ? "pagerduty" : "slack", kind, severity: sev, dedupKey: b.fingerprint, summary, runbook: b.slo.runbook, decisions: [],
    });
    if (b.firing && b.prev.phase !== "firing" && !maintAll) {
      const n = synth("trigger", `Error budget burning fast: ${b.slo.label} (${b.shortBurn === null ? "n/a" : b.shortBurn.toFixed(1)}x allowed rate)`);
      if (n.channel === "pagerduty") pagesUsed++;
      burnNotifications.push(n);
      if (b.impact === "major") await ports.openIncident({ dedupeKey: b.fingerprint, title: "Voice AI degraded", impact: "minor", component: b.slo.component, region: null, message: "Some calls may be affected. We are investigating and will post an update shortly." });
    } else if (b.resolve && !maintAll) {
      burnNotifications.push(synth("resolve", `Recovered: ${b.slo.label}`));
      await ports.resolveIncident({ dedupeKey: b.fingerprint, message: "Service has recovered." });
    }
  }

  // Deliver. A failed delivery rewinds lastNotifiedAt so the next cycle retries instead of staying silent.
  const all = [...regular, ...burnNotifications];
  const failed = new Set<string>();
  let delivered = 0;
  for (const n of all) {
    const ok = await ports.deliver(n).catch(() => false);
    await ports.logDelivery(n, ok).catch(() => undefined);
    if (ok) delivered++; else if (n.kind !== "resolve") failed.add(n.dedupKey);
  }

  // Status page: only SEV1/SEV2 rules with a public component, customer-safe copy.
  for (const d of decisions) {
    if (d.muted || !d.rule.publicComponent || (d.rule.severity !== "SEV1" && d.rule.severity !== "SEV2")) continue;
    if (d.action === "open") {
      const copy = statusCopy(d.rule, d.scopeKey);
      await ports.openIncident({ dedupeKey: d.fingerprint, title: copy.title, impact: copy.impact, component: d.rule.publicComponent, region: d.rule.scope === "region" ? d.scopeKey : null, message: copy.message });
    } else if (d.action === "resolve") {
      await ports.resolveIncident({ dedupeKey: d.fingerprint, message: "Service has recovered. Thank you for your patience." });
    }
  }

  // Persist state last. Retry delivery on the next cycle for failed triggers.
  for (const d of decisions) {
    const next = failed.has(`obs:${d.rule.key}`) && d.next.phase === "firing" ? { ...d.next, lastNotifiedAt: null } : d.next;
    await ports.saveState(d.fingerprint, d.rule.key, d.scopeKey, next);
  }
  for (const b of burnDecisions) {
    const phase: AlertState["phase"] = b.firing ? "firing" : b.resolve ? "ok" : b.prev.phase;
    const lost = failed.has(b.fingerprint);
    await ports.saveState(b.fingerprint, "burn", b.slo.key, { ...EMPTY_STATE, ...b.prev, phase: lost ? "ok" : phase });
  }

  return {
    evaluated: decisions.length + burnDecisions.length,
    opened: decisions.filter((d) => d.action === "open").length,
    resolved: decisions.filter((d) => d.action === "resolve").length,
    renotified: decisions.filter((d) => d.action === "renotify").length,
    delivered, deliveryFailures: failed.size, notifications: all,
  };
}
