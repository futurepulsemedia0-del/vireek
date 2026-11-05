// supabase/functions/_shared/observability/alertRules.ts
//
// Real-traffic alert rules + the anti-fatigue state machine. Pure: takes metric samples and the
// previous state, returns decisions. The edge function does the I/O (read metrics, persist state, notify).
//
// Fatigue controls (each is unit-tested):
//   volume gate   - a rule cannot fire on fewer than `minSamples` events (3 bad calls is not an outage)
//   confirmation  - N consecutive breached evaluations before opening (kills flapping spikes)
//   hysteresis    - M consecutive healthy evaluations before resolving; recovery threshold is stricter
//   cooldown      - a still-firing alert re-notifies only on escalation or after `renotifyMinutes`
//   dedupe        - one alert per (rule, scope); fingerprint is stable
//   grouping      - several regions/providers breaching the same rule collapse into ONE page
//   page budget   - at most `maxPagesPerHour` pages; overflow downgrades to chat digest (SEV1 is never downgraded)
//   maintenance   - muted scopes still record state, never notify
//   inhibition    - while a MORE severe rule is firing on the same metric+scope, the milder rule stays silent

export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";
export type Route = "page" | "chat" | "ticket";
export type MetricKey =
  | "turn_latency_p95_ms" | "time_to_first_word_p95_ms" | "answer_rate" | "call_completion_rate"
  | "booking_success_rate" | "tool_failure_rate" | "webhook_error_rate" | "provider_error_rate" | "asr_confidence_avg";
export type ScopeKind = "global" | "region" | "provider";

export interface AlertRule {
  key: string;
  title: string;
  metric: MetricKey;
  comparator: "gt" | "lt";
  threshold: number;
  /** Strictly better than threshold: required to count as healthy (hysteresis). */
  recoveryThreshold: number;
  windowMinutes: number;
  minSamples: number;
  confirmations: number;
  recoveryConfirmations: number;
  severity: Severity;
  scope: ScopeKind;
  runbook: string;
  /** Customer-visible impact => also drives the public status page for SEV1/SEV2. */
  publicComponent?: string;
}

const RB = "docs/runbooks";
export const DEFAULT_RULES: AlertRule[] = [
  { key: "turn_latency_p95_critical", title: "Voice turn latency p95 critically high", metric: "turn_latency_p95_ms", comparator: "gt", threshold: 4000, recoveryThreshold: 3000, windowMinutes: 15, minSamples: 30, confirmations: 2, recoveryConfirmations: 3, severity: "SEV2", scope: "region", runbook: `${RB}/voice-latency-high.md`, publicComponent: "voice-ai" },
  { key: "turn_latency_p95_warn", title: "Voice turn latency p95 elevated", metric: "turn_latency_p95_ms", comparator: "gt", threshold: 2500, recoveryThreshold: 2000, windowMinutes: 30, minSamples: 40, confirmations: 3, recoveryConfirmations: 3, severity: "SEV3", scope: "region", runbook: `${RB}/voice-latency-high.md` },
  { key: "ttfw_p95_high", title: "Time to first word p95 high", metric: "time_to_first_word_p95_ms", comparator: "gt", threshold: 3000, recoveryThreshold: 2200, windowMinutes: 30, minSamples: 15, confirmations: 3, recoveryConfirmations: 3, severity: "SEV3", scope: "region", runbook: `${RB}/voice-latency-high.md` },
  { key: "answer_rate_critical", title: "AI is not answering calls", metric: "answer_rate", comparator: "lt", threshold: 0.9, recoveryThreshold: 0.97, windowMinutes: 10, minSamples: 10, confirmations: 2, recoveryConfirmations: 3, severity: "SEV1", scope: "region", runbook: `${RB}/voice-answer-rate-drop.md`, publicComponent: "voice-ai" },
  { key: "answer_rate_warn", title: "Answer rate degraded", metric: "answer_rate", comparator: "lt", threshold: 0.97, recoveryThreshold: 0.985, windowMinutes: 30, minSamples: 20, confirmations: 3, recoveryConfirmations: 3, severity: "SEV2", scope: "region", runbook: `${RB}/voice-answer-rate-drop.md` },
  { key: "call_completion_low", title: "Call completion rate low", metric: "call_completion_rate", comparator: "lt", threshold: 0.9, recoveryThreshold: 0.94, windowMinutes: 30, minSamples: 25, confirmations: 3, recoveryConfirmations: 3, severity: "SEV3", scope: "region", runbook: `${RB}/voice-answer-rate-drop.md` },
  { key: "booking_success_low", title: "Booking success rate low", metric: "booking_success_rate", comparator: "lt", threshold: 0.7, recoveryThreshold: 0.8, windowMinutes: 60, minSamples: 15, confirmations: 2, recoveryConfirmations: 3, severity: "SEV3", scope: "global", runbook: `${RB}/voice-tool-failures.md`, publicComponent: "crm-sync" },
  { key: "tool_failure_high", title: "Voice tool-call failure rate high", metric: "tool_failure_rate", comparator: "gt", threshold: 0.1, recoveryThreshold: 0.05, windowMinutes: 15, minSamples: 30, confirmations: 2, recoveryConfirmations: 3, severity: "SEV3", scope: "global", runbook: `${RB}/voice-tool-failures.md` },
  { key: "webhook_5xx_high", title: "Vapi webhook error rate high", metric: "webhook_error_rate", comparator: "gt", threshold: 0.02, recoveryThreshold: 0.005, windowMinutes: 10, minSamples: 50, confirmations: 2, recoveryConfirmations: 3, severity: "SEV2", scope: "global", runbook: `${RB}/voice-webhook-errors.md`, publicComponent: "api" },
  { key: "provider_error_high", title: "Voice provider error rate high", metric: "provider_error_rate", comparator: "gt", threshold: 0.05, recoveryThreshold: 0.02, windowMinutes: 15, minSamples: 30, confirmations: 2, recoveryConfirmations: 3, severity: "SEV2", scope: "provider", runbook: `${RB}/voice-provider-outage.md`, publicComponent: "voice-ai" },
  { key: "asr_confidence_low", title: "ASR confidence trending low", metric: "asr_confidence_avg", comparator: "lt", threshold: 0.7, recoveryThreshold: 0.78, windowMinutes: 120, minSamples: 50, confirmations: 3, recoveryConfirmations: 3, severity: "SEV4", scope: "global", runbook: `${RB}/voice-provider-outage.md` },
];

export interface MetricSample { metric: MetricKey; scopeKey: string; value: number | null; samples: number }

export type AlertPhase = "ok" | "pending" | "firing";
export interface AlertState {
  phase: AlertPhase;
  breaches: number;
  healthy: number;
  openedAt: string | null;
  lastNotifiedAt: string | null;
  lastSeverity: Severity | null;
  notifications: number;
}
export const EMPTY_STATE: AlertState = { phase: "ok", breaches: 0, healthy: 0, openedAt: null, lastNotifiedAt: null, lastSeverity: null, notifications: 0 };

export interface Decision {
  rule: AlertRule;
  scopeKey: string;
  fingerprint: string;
  action: "open" | "renotify" | "resolve" | "none";
  muted: boolean;
  value: number | null;
  samples: number;
  next: AlertState;
}

export interface EvalOptions {
  now: Date;
  renotifyMinutes?: Record<Severity, number>;
  /** scope keys (or "*" ) under maintenance */
  maintenance?: string[];
}
export const RENOTIFY: Record<Severity, number> = { SEV1: 30, SEV2: 120, SEV3: 720, SEV4: 10_080 };
export const fingerprintOf = (ruleKey: string, scopeKey: string): string => `obs:${ruleKey}:${scopeKey}`;

function breached(rule: AlertRule, v: number): boolean {
  return rule.comparator === "gt" ? v > rule.threshold : v < rule.threshold;
}
function recovered(rule: AlertRule, v: number): boolean {
  return rule.comparator === "gt" ? v <= rule.recoveryThreshold : v >= rule.recoveryThreshold;
}

export function evaluateRule(rule: AlertRule, sample: MetricSample, prev: AlertState, opts: EvalOptions): Decision {
  const scopeKey = sample.scopeKey;
  const muted = (opts.maintenance ?? []).some((m) => m === "*" || m === scopeKey || m === rule.key);
  const renotify = (opts.renotifyMinutes ?? RENOTIFY)[rule.severity];
  const base = { rule, scopeKey, fingerprint: fingerprintOf(rule.key, scopeKey), muted, value: sample.value, samples: sample.samples };
  let next: AlertState = { ...prev };

  const enough = sample.value !== null && sample.samples >= rule.minSamples;
  // Not enough data: never open, never resolve (absence of evidence is not recovery). Hold state.
  if (!enough) return { ...base, action: "none", next };

  const v = sample.value as number;
  if (breached(rule, v)) {
    next.healthy = 0;
    next.breaches = prev.breaches + 1;
    if (prev.phase === "firing") {
      const last = prev.lastNotifiedAt ? Date.parse(prev.lastNotifiedAt) : 0;
      const due = opts.now.getTime() - last >= renotify * 60_000;
      if (due) { next.lastNotifiedAt = opts.now.toISOString(); next.notifications = prev.notifications + 1; return { ...base, action: muted ? "none" : "renotify", next }; }
      return { ...base, action: "none", next };
    }
    if (next.breaches >= rule.confirmations) {
      next = { phase: "firing", breaches: next.breaches, healthy: 0, openedAt: opts.now.toISOString(), lastNotifiedAt: muted ? null : opts.now.toISOString(), lastSeverity: rule.severity, notifications: muted ? 0 : 1 };
      return { ...base, action: muted ? "none" : "open", next };
    }
    next.phase = "pending";
    return { ...base, action: "none", next };
  }

  // Not breached.
  if (prev.phase === "firing") {
    if (recovered(rule, v)) {
      next.healthy = prev.healthy + 1;
      if (next.healthy >= rule.recoveryConfirmations) {
        next = { ...EMPTY_STATE };
        return { ...base, action: prev.notifications > 0 ? "resolve" : "none", next };
      }
    } else next.healthy = 0; // between threshold and recovery threshold: stay firing, no flapping
    return { ...base, action: "none", next };
  }
  next = { ...EMPTY_STATE };
  return { ...base, action: "none", next };
}

export interface RoutedNotification {
  channel: "pagerduty" | "slack" | "ticket";
  kind: "trigger" | "resolve" | "digest";
  severity: Severity;
  dedupKey: string;
  summary: string;
  runbook: string;
  decisions: Decision[];
}

export const routeFor = (sev: Severity): Route => (sev === "SEV1" || sev === "SEV2" ? "page" : sev === "SEV3" ? "chat" : "ticket");

/**
 * Turn decisions into notifications: group by rule (one page for "3 regions breaching"), enforce the page budget.
 * `pagesSentLastHour` is the count already sent; overflow SEV2 pages degrade to chat. SEV1 is never degraded.
 */
export function buildNotifications(decisions: Decision[], pagesSentLastHour: number, maxPagesPerHour = 6): RoutedNotification[] {
  const out: RoutedNotification[] = [];
  // One PagerDuty incident per RULE (all scopes grouped). It may only resolve when no scope of that rule is still firing.
  const stillFiring = new Set(decisions.filter((d) => d.next.phase === "firing").map((d) => d.rule.key));
  const rank: Record<Severity, number> = { SEV1: 1, SEV2: 2, SEV3: 3, SEV4: 4 };
  const inhibited = (d: Decision): boolean =>
    decisions.some((o) => o !== d && o.rule.metric === d.rule.metric && o.scopeKey === d.scopeKey && o.next.phase === "firing" && rank[o.rule.severity] < rank[d.rule.severity]);
  const active = decisions.filter((d) => !d.muted && (d.action === "resolve" || ((d.action === "open" || d.action === "renotify") && !inhibited(d))));
  const byRuleAction = new Map<string, Decision[]>();
  for (const d of active) {
    const k = `${d.rule.key}|${d.action === "resolve" ? "resolve" : "trigger"}`;
    byRuleAction.set(k, [...(byRuleAction.get(k) ?? []), d]);
  }
  let pages = pagesSentLastHour;
  for (const [k, group] of byRuleAction) {
    const rule = group[0].rule;
    const resolve = k.endsWith("|resolve");
    if (resolve && stillFiring.has(rule.key)) continue;
    const scopes = group.map((g) => g.scopeKey).sort();
    const summary = `${rule.title} — ${scopes.length > 1 ? `${scopes.length} scopes (${scopes.slice(0, 4).join(", ")}${scopes.length > 4 ? ", …" : ""})` : scopes[0]}`;
    let route = routeFor(rule.severity);
    if (route === "page" && !resolve) {
      if (rule.severity !== "SEV1" && pages >= maxPagesPerHour) route = "chat";
      else pages++;
    }
    const dedupKey = `obs:${rule.key}`;
    out.push({
      channel: route === "page" ? "pagerduty" : route === "chat" ? "slack" : "ticket",
      kind: resolve ? "resolve" : route === "ticket" ? "digest" : "trigger",
      severity: rule.severity, dedupKey, summary, runbook: rule.runbook, decisions: group,
    });
    // A page is always mirrored to chat so humans see context; resolves too.
    if (route === "page") out.push({ channel: "slack", kind: resolve ? "resolve" : "trigger", severity: rule.severity, dedupKey, summary, runbook: rule.runbook, decisions: group });
  }
  return out;
}

const PD_SEVERITY: Record<Severity, "critical" | "error" | "warning" | "info"> = { SEV1: "critical", SEV2: "error", SEV3: "warning", SEV4: "info" };

/** PagerDuty Events API v2 body. */
export function pagerDutyBody(n: RoutedNotification, routingKey: string, source: string, baseUrl: string) {
  return {
    routing_key: routingKey,
    event_action: n.kind === "resolve" ? "resolve" : "trigger",
    dedup_key: n.dedupKey,
    payload: {
      summary: `[${n.severity}] ${n.summary}`.slice(0, 1024),
      source,
      severity: PD_SEVERITY[n.severity],
      component: "voice",
      custom_details: Object.fromEntries(n.decisions.map((d) => [d.scopeKey, { value: d.value, samples: d.samples, threshold: d.rule.threshold }])),
    },
    links: [{ href: `${baseUrl.replace(/\/$/, "")}/${n.runbook}`, text: "Runbook" }],
  };
}

/** Slack-compatible incoming-webhook body. No customer data: only metric values and scope names. */
export function slackBody(n: RoutedNotification, baseUrl: string) {
  const icon = n.kind === "resolve" ? "✅" : n.severity === "SEV1" ? "🔴" : n.severity === "SEV2" ? "🟠" : "🟡";
  const lines = n.decisions.map((d) => `• ${d.scopeKey}: ${d.value === null ? "n/a" : Number(d.value.toFixed(4))} (threshold ${d.rule.comparator === "gt" ? ">" : "<"} ${d.rule.threshold}, n=${d.samples})`);
  return { text: `${icon} [${n.severity}] ${n.kind === "resolve" ? "Resolved: " : ""}${n.summary}\n${lines.join("\n")}\nRunbook: ${baseUrl.replace(/\/$/, "")}/${n.runbook}` };
}

/** Customer-safe status copy. Never includes internal metric values, provider names or customer data. */
export function statusCopy(rule: AlertRule, scopeKey: string): { title: string; message: string; impact: "minor" | "major" } {
  const where = rule.scope === "region" && scopeKey !== "global" ? ` in ${scopeKey}` : "";
  const what =
    rule.metric === "answer_rate" ? "Some calls are not being answered by the AI receptionist"
    : rule.metric === "booking_success_rate" ? "Appointments created from calls may be delayed"
    : rule.metric === "webhook_error_rate" ? "Some automated notifications may be delayed"
    : "The AI receptionist is responding more slowly than usual";
  return { title: `Voice AI degraded${where}`, message: `${what}${where}. We are investigating and will post an update shortly.`, impact: rule.severity === "SEV1" ? "major" : "minor" };
}
