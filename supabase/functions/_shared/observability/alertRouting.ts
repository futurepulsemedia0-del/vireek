// supabase/functions/_shared/observability/alertRouting.ts
//
// Vendor-neutral alert routing. Pure: no I/O, no env reads, no secrets.
//
// alertRules.ts decides WHETHER something is notified and on which logical route (page | chat | ticket).
// This module decides WHERE that notification goes: a list of webhook destinations, each with a payload
// format. A destination never contains a URL — only the NAME of the environment variable that holds it
// (`urlEnv`), so the config can live in git. The edge function resolves the env var at delivery time.
//
// Formats:
//   generic      Vireek's own neutral JSON envelope (works with any webhook receiver / automation tool)
//   slack        Slack-compatible incoming webhook ({ text })
//   pagerduty-v2 PagerDuty Events API v2 body (kept for the existing integration; optional, not required)
//
// Backward compatibility: DEFAULT_ROUTING reproduces the behaviour that existed before this module
// (SEV1/SEV2 -> pagerduty-v2 + slack mirror, SEV3 -> slack, SEV4 -> ticket webhook that falls back to slack).

import type { RoutedNotification, Severity } from "./alertRules.ts";
import { pagerDutyBody, slackBody } from "./alertRules.ts";

export type DestinationFormat = "generic" | "slack" | "pagerduty-v2";
export type LogicalRoute = "page" | "chat" | "ticket";

export interface Destination {
  /** Stable identifier used in rules and logs. Lowercase, [a-z0-9_-]. */
  name: string;
  format: DestinationFormat;
  /** Name of the env var holding the webhook URL (or, for pagerduty-v2, nothing — see routingKeyEnv). */
  urlEnv: string;
  /** pagerduty-v2 only: env var holding the integration routing key. */
  routingKeyEnv?: string;
  /** Another destination name to try when this one is not configured or fails. One hop only. */
  fallback?: string;
  /** Counts toward the hourly page budget when it receives a trigger. */
  isPaging?: boolean;
}

export interface RoutingRule {
  /** Exact severity list. */
  severities: Severity[];
  /** Optional: restrict to these alert rule keys (dedupKey is `obs:<ruleKey>` or `obs:burn:<slo>`). */
  ruleKeys?: string[];
  /** Destination names that receive the notification. Must all exist. */
  to: string[];
  /** Resolves are sent too unless this is false. Default true. */
  sendResolves?: boolean;
}

export interface RoutingConfig {
  destinations: Destination[];
  rules: RoutingRule[];
}

export const DEFAULT_ROUTING: RoutingConfig = {
  destinations: [
    // Optional: only active when PAGERDUTY_ROUTING_KEY is set. PAGERDUTY_EVENTS_URL is an optional endpoint override.
    { name: "pager", format: "pagerduty-v2", urlEnv: "PAGERDUTY_EVENTS_URL", routingKeyEnv: "PAGERDUTY_ROUTING_KEY", isPaging: true },
    // Vendor-neutral: any paging/automation tool that accepts a webhook. Active when ALERT_PAGER_WEBHOOK_URL is set.
    { name: "pager-webhook", format: "generic", urlEnv: "ALERT_PAGER_WEBHOOK_URL", isPaging: true },
    { name: "chat", format: "slack", urlEnv: "ALERT_SLACK_WEBHOOK_URL" },
    { name: "ticket", format: "slack", urlEnv: "ALERT_TICKET_WEBHOOK_URL", fallback: "chat" },
  ],
  rules: [
    { severities: ["SEV1", "SEV2"], to: ["pager", "pager-webhook", "chat"] },
    { severities: ["SEV3"], to: ["chat"] },
    { severities: ["SEV4"], to: ["ticket"] },
  ],
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SEVERITIES: Severity[] = ["SEV1", "SEV2", "SEV3", "SEV4"];
const FORMATS: DestinationFormat[] = ["generic", "slack", "pagerduty-v2"];

/** Returns a list of problems; empty means valid. Never throws. */
export function validateRouting(cfg: RoutingConfig): string[] {
  const errs: string[] = [];
  const names = new Set<string>();
  for (const d of cfg.destinations) {
    if (!NAME_RE.test(d.name)) errs.push(`destination name invalid: ${d.name}`);
    if (names.has(d.name)) errs.push(`duplicate destination: ${d.name}`);
    names.add(d.name);
    if (!FORMATS.includes(d.format)) errs.push(`${d.name}: unknown format ${String(d.format)}`);
    if (!ENV_RE.test(d.urlEnv)) errs.push(`${d.name}: urlEnv must be an env var NAME, got a value that looks like something else`);
    if (d.format === "pagerduty-v2" && !(d.routingKeyEnv && ENV_RE.test(d.routingKeyEnv))) errs.push(`${d.name}: pagerduty-v2 needs routingKeyEnv`);
    if (d.format !== "pagerduty-v2" && d.routingKeyEnv) errs.push(`${d.name}: routingKeyEnv only valid for pagerduty-v2`);
  }
  for (const d of cfg.destinations) {
    if (d.fallback && !names.has(d.fallback)) errs.push(`${d.name}: fallback ${d.fallback} does not exist`);
    if (d.fallback === d.name) errs.push(`${d.name}: fallback cannot be itself`);
    const fb = d.fallback ? cfg.destinations.find((x) => x.name === d.fallback) : undefined;
    if (fb?.fallback) errs.push(`${d.name}: fallback chains longer than one hop are not allowed`);
  }
  cfg.rules.forEach((r, i) => {
    if (r.severities.length === 0) errs.push(`rule[${i}]: severities empty`);
    for (const s of r.severities) if (!SEVERITIES.includes(s)) errs.push(`rule[${i}]: unknown severity ${String(s)}`);
    if (r.to.length === 0) errs.push(`rule[${i}]: to empty`);
    for (const t of r.to) if (!names.has(t)) errs.push(`rule[${i}]: unknown destination ${t}`);
  });
  // Safety: SEV1 must always reach at least one paging destination, otherwise the config is unsafe.
  const paging = new Set(cfg.destinations.filter((d) => d.isPaging).map((d) => d.name));
  const sev1Pages = cfg.rules.some((r) => r.severities.includes("SEV1") && r.to.some((t) => paging.has(t)));
  if (!sev1Pages) errs.push("SEV1 is not routed to any paging destination");
  return errs;
}

/**
 * Parse an override from an env var (JSON). Invalid input returns the default and the reasons, so a typo in
 * a secret can never silence alerting. The override can only reference env var NAMES.
 */
export function parseRoutingOverride(raw: string | undefined | null): { config: RoutingConfig; errors: string[]; overridden: boolean } {
  if (!raw || !raw.trim()) return { config: DEFAULT_ROUTING, errors: [], overridden: false };
  if (raw.length > 8_000) return { config: DEFAULT_ROUTING, errors: ["override too large"], overridden: false };
  try {
    const parsed = JSON.parse(raw) as Partial<RoutingConfig>;
    if (!parsed || !Array.isArray(parsed.destinations) || !Array.isArray(parsed.rules)) return { config: DEFAULT_ROUTING, errors: ["override must have destinations[] and rules[]"], overridden: false };
    const cfg: RoutingConfig = { destinations: parsed.destinations as Destination[], rules: parsed.rules as RoutingRule[] };
    const errors = validateRouting(cfg);
    return errors.length ? { config: DEFAULT_ROUTING, errors, overridden: false } : { config: cfg, errors: [], overridden: true };
  } catch {
    return { config: DEFAULT_ROUTING, errors: ["override is not valid JSON"], overridden: false };
  }
}

/** Which destinations should receive this notification (before fallbacks and availability). */
export function selectDestinations(n: RoutedNotification, cfg: RoutingConfig): Destination[] {
  const out: Destination[] = [];
  const seen = new Set<string>();
  for (const r of cfg.rules) {
    if (!r.severities.includes(n.severity)) continue;
    if (r.ruleKeys && !r.ruleKeys.some((k) => n.dedupKey === `obs:${k}` || n.dedupKey === `obs:burn:${k}`)) continue;
    if (n.kind === "resolve" && r.sendResolves === false) continue;
    for (const name of r.to) {
      const d = cfg.destinations.find((x) => x.name === name);
      if (d && !seen.has(d.name)) { seen.add(d.name); out.push(d); }
    }
  }
  return out;
}

/**
 * Anti-fatigue interplay: alertRules.buildNotifications already degrades SEV2 pages to chat when the page
 * budget is exhausted (n.channel === "slack"). Honour that: a notification the engine decided is NOT a page
 * must never reach a paging destination, whatever the routing table says. SEV1 is never degraded by the engine.
 */
export function enforceEngineDecision(n: RoutedNotification, dests: Destination[]): Destination[] {
  if (n.channel === "pagerduty") return dests;
  return dests.filter((d) => !d.isPaging);
}

export interface WebhookRequest { url: string; body: unknown; destination: string; paging: boolean }

export interface EnvReader { (name: string): string | undefined }

/** Generic neutral envelope. Metric values and scope names only — never customer data. */
export function genericBody(n: RoutedNotification, baseUrl: string, source: string) {
  return {
    schema: "vireek.alert.v1",
    source,
    event: n.kind,
    severity: n.severity,
    dedup_key: n.dedupKey,
    summary: n.summary.slice(0, 1024),
    runbook_url: `${baseUrl.replace(/\/$/, "")}/${n.runbook}`,
    scopes: n.decisions.map((d) => ({ scope: d.scopeKey, value: d.value, samples: d.samples, threshold: d.rule.threshold, comparator: d.rule.comparator })),
  };
}

const PD_URL = "https://events.pagerduty.com/v2/enqueue";

/**
 * Build the concrete requests for a notification. A destination that is not configured (env var missing)
 * is replaced by its fallback if any; otherwise it is skipped and reported in `unconfigured`.
 * The webhook URL must be https (http only for localhost, for local receivers in tests).
 */
export function buildRequests(
  n: RoutedNotification, cfg: RoutingConfig, env: EnvReader, baseUrl: string, source: string,
): { requests: WebhookRequest[]; unconfigured: string[] } {
  const requests: WebhookRequest[] = [];
  const unconfigured: string[] = [];
  const used = new Set<string>();
  const dests = enforceEngineDecision(n, selectDestinations(n, cfg));

  const resolve = (d: Destination, hop = 0): void => {
    const url = d.format === "pagerduty-v2" ? (env(d.routingKeyEnv ?? "") ? (env(d.urlEnv) ?? PD_URL) : undefined) : env(d.urlEnv);
    if (url && isSafeUrl(url) && !used.has(`${d.name}`)) {
      used.add(d.name);
      requests.push({ destination: d.name, url, paging: d.isPaging === true, body: bodyFor(d, n, env, baseUrl, source) });
      return;
    }
    if (d.fallback && hop === 0) {
      const fb = cfg.destinations.find((x) => x.name === d.fallback);
      if (fb && !used.has(fb.name)) return resolve(fb, 1);
    }
    unconfigured.push(d.name);
  };
  for (const d of dests) resolve(d);

  // Two destinations may share one URL env (e.g. pager vs pager-webhook alternatives). Send each URL once.
  const seenUrl = new Set<string>();
  // Note: a destination that fell back to a non-paging destination is not a paging request (paging comes from the destination actually used).
  const unique = requests.filter((r) => { if (seenUrl.has(r.url)) return false; seenUrl.add(r.url); return true; });
  return { requests: unique, unconfigured };
}

function bodyFor(d: Destination, n: RoutedNotification, env: EnvReader, baseUrl: string, source: string): unknown {
  if (d.format === "pagerduty-v2") return pagerDutyBody(n, env(d.routingKeyEnv ?? "") ?? "", source, baseUrl);
  if (d.format === "slack") return slackBody(n, baseUrl);
  return genericBody(n, baseUrl, source);
}

export function isSafeUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && (x.hostname === "localhost" || x.hostname === "127.0.0.1");
  } catch { return false; }
}
