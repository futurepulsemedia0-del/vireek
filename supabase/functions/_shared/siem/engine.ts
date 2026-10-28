// supabase/functions/_shared/siem/engine.ts
//
// Pure logic for SIEM log streaming (Splunk HEC + Datadog Logs). No Deno / network /
// Supabase imports, so it is unit-tested with vitest (engine.test.ts) and shared by
// the `siem-stream` edge function.
//
// Integrity rules:
//   1. Secrets never reach an event: metadata is deep-redacted before leaving Vireek.
//   2. A destination URL can only be https, public, credential-free (SSRF protection);
//      Datadog endpoints are BUILT from an allow-listed site, never taken from input.
//   3. Delivery is at-least-once; every event carries the audit_log id for de-duplication.

export type SiemProvider = 'splunk_hec' | 'datadog';
export type Severity = 'info' | 'low' | 'medium' | 'high';
export type Category = 'authentication' | 'identity_access' | 'data' | 'configuration' | 'other';
export type HttpClass = 'ok' | 'auth' | 'retry' | 'permanent';

export const DATADOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'ddog-gov.com',
] as const;

export const SEVERITIES: Severity[] = ['info', 'low', 'medium', 'high'];
export const MAX_BATCH_EVENTS = 200;
export const MAX_BATCH_BYTES = 900_000;
export const MAX_CONSECUTIVE_FAILURES = 10;
export const MAX_DESTINATIONS_PER_ACCOUNT = 5;
export const SIEM_PLANS = ['business', 'enterprise'];

export interface AuditRow {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_table: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
}

export interface SiemEvent {
  id: string;
  time: string;
  account_id: string;
  action: string;
  category: Category;
  severity: Severity;
  actor: { id: string | null; email: string | null };
  target: { table: string | null; id: string | null };
  metadata: Record<string, unknown> | null;
}

export interface DestinationConfig {
  provider: SiemProvider;
  endpoint_url: string | null;
  datadog_site: string | null;
  splunk_index: string | null;
  splunk_sourcetype: string | null;
}

// ------------------------------------------------------------------
// Redaction
// ------------------------------------------------------------------

const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key|otp|recovery[_-]?code/i;
export const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ------------------------------------------------------------------
// Classification
// ------------------------------------------------------------------

const CATEGORY_RULES: Array<[RegExp, Category]> = [
  [/(login|logout|mfa|passkey|session|trusted_device|recovery_code|otp|password|sso_login)/, 'authentication'],
  [/(role|permission|team_member|member_|invite|sso_|ip_rule|ip_allow|security_policy|api_key|owner_transfer)/, 'identity_access'],
  [/(export|download|purge|trash|restore|dsar|erase|account_deleted|backup)/, 'data'],
  [/(settings|config|policy|integration|siem_|webhook|branding|billing)/, 'configuration'],
];

const SEVERITY_RULES: Array<[RegExp, Severity]> = [
  [/(mfa_(disabled|unenrolled|removed)|sso_domain_removed|security_policy_updated|ip_rule_deleted|account_deleted|workspace_export|data_export|api_key_created|owner_transfer|siem_destination_(deleted|failing)|passkey_removed)/, 'high'],
  [/(custom_role_|ip_rule_added|sso_domain_registered|team_member_|member_removed|_deleted|_revoked|_exported|_purged|siem_destination_)/, 'medium'],
  [/(_updated|_changed|_created|_assigned|_unassigned|_added)/, 'low'],
];

export function categorize(action: string): { category: Category; severity: Severity } {
  const a = (action ?? '').toLowerCase();
  const category = CATEGORY_RULES.find(([re]) => re.test(a))?.[1] ?? 'other';
  const severity = SEVERITY_RULES.find(([re]) => re.test(a))?.[1] ?? 'info';
  return { category, severity };
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function meetsMinSeverity(s: Severity, min: Severity): boolean {
  return severityRank(s) >= severityRank(min);
}

export function toSiemEvent(row: AuditRow, accountId: string): SiemEvent {
  const { category, severity } = categorize(row.action);
  const meta = row.metadata && typeof row.metadata === 'object' ? (redact(row.metadata) as Record<string, unknown>) : null;
  return {
    id: row.id,
    time: new Date(row.created_at).toISOString(),
    account_id: accountId,
    action: row.action,
    category,
    severity,
    actor: { id: row.actor_id, email: row.actor_email },
    target: { table: row.target_table, id: row.target_id },
    metadata: meta && Object.keys(meta).length ? meta : null,
  };
}

// ------------------------------------------------------------------
// URL / host validation (SSRF protection)
// ------------------------------------------------------------------

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((n) => n > 255) ? null : p;
}

export function isPrivateIPv4(host: string): boolean {
  const p = ipv4Parts(host);
  if (!p) return false;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224
  );
}

export function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host.startsWith('[') || host.includes(':')) return true; // IPv6 literals are not accepted
  if (isPrivateIPv4(host)) return true;
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true; // decimal / hex IP tricks
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|internal|lan|intranet|corp|home|localdomain)$/.test(host)) return true;
  if (host === 'metadata.google.internal') return true;
  if (!host.includes('.')) return true; // single-label names resolve inside private networks
  return false;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const HEC_PATH = '/services/collector/event';

/** Validates a Splunk HEC base URL and returns the normalised full event endpoint. */
export function validateSplunkUrl(raw: string): UrlCheck {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, error: 'Enter your Splunk HEC URL.' };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: 'Enter a valid URL, e.g. https://http-inputs-acme.splunkcloud.com:443' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'The HEC URL must use https://.' };
  if (u.username || u.password) return { ok: false, error: 'Remove credentials from the URL; paste the token in the token field.' };
  if (isBlockedHost(u.hostname)) return { ok: false, error: 'That host is not reachable from the public internet.' };
  const port = u.port ? Number(u.port) : 443;
  if (!(port === 443 || (port >= 1024 && port <= 65535))) return { ok: false, error: 'Use port 443 or a port between 1024 and 65535.' };
  let path = u.pathname.replace(/\/+$/, '');
  if (path.endsWith('/services/collector')) path = `${path}/event`;
  else if (!path.endsWith(HEC_PATH)) path = `${path}${HEC_PATH}`;
  return { ok: true, url: `https://${u.host}${path}` };
}

export function datadogEndpoint(site: string | null | undefined): string | null {
  const s = (site ?? '').trim().toLowerCase();
  return (DATADOG_SITES as readonly string[]).includes(s) ? `https://http-intake.logs.${s}/api/v2/logs` : null;
}

export function isValidSecret(secret: string): boolean {
  return typeof secret === 'string' && secret.length >= 8 && secret.length <= 512 && !/[\s\u0000-\u001f]/.test(secret);
}

export function isValidSplunkIndex(v: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(v);
}

export function isValidSourcetype(v: string): boolean {
  return /^[a-zA-Z0-9_:.-]{1,80}$/.test(v);
}

// ------------------------------------------------------------------
// Request building
// ------------------------------------------------------------------

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const tagSafe = (v: string) => v.toLowerCase().replace(/[^a-z0-9_.\-:/]/g, '_').slice(0, 100);

const DD_STATUS: Record<Severity, string> = { info: 'info', low: 'info', medium: 'warn', high: 'error' };

export function buildSplunkBody(events: SiemEvent[], cfg: Pick<DestinationConfig, 'splunk_index' | 'splunk_sourcetype'>): string {
  return events
    .map((e) => {
      const envelope: Record<string, unknown> = {
        time: Math.round(new Date(e.time).getTime()) / 1000,
        host: 'vireek',
        source: 'vireek:audit',
        sourcetype: cfg.splunk_sourcetype || 'vireek:audit',
        event: e,
      };
      if (cfg.splunk_index) envelope.index = cfg.splunk_index;
      return JSON.stringify(envelope);
    })
    .join('\n');
}

export function buildDatadogBody(events: SiemEvent[]): string {
  return JSON.stringify(
    events.map((e) => ({
      ddsource: 'vireek',
      ddtags: `service:vireek,category:${tagSafe(e.category)},severity:${e.severity},action:${tagSafe(e.action)}`,
      hostname: 'vireek',
      service: 'vireek',
      status: DD_STATUS[e.severity],
      date: e.time,
      message: `${e.action}${e.actor.email ? ` by ${e.actor.email}` : ''}`,
      usr: { id: e.actor.id, email: e.actor.email },
      evt: { name: e.action, category: e.category },
      vireek: e,
    })),
  );
}

export function buildRequest(cfg: DestinationConfig, secret: string, events: SiemEvent[]): BuiltRequest | null {
  if (cfg.provider === 'splunk_hec') {
    const check = validateSplunkUrl(cfg.endpoint_url ?? '');
    if (!check.ok) return null;
    return {
      url: check.url,
      headers: { 'Content-Type': 'application/json', Authorization: `Splunk ${secret}` },
      body: buildSplunkBody(events, cfg),
    };
  }
  const url = datadogEndpoint(cfg.datadog_site);
  if (!url) return null;
  return {
    url,
    headers: { 'Content-Type': 'application/json', 'DD-API-KEY': secret },
    body: buildDatadogBody(events),
  };
}

// ------------------------------------------------------------------
// Batching, retry policy
// ------------------------------------------------------------------

/** Splits items into contiguous chunks bounded by count and approximate byte size. */
export function chunkBySize<T>(items: T[], size: (t: T) => number, maxItems = MAX_BATCH_EVENTS, maxBytes = MAX_BATCH_BYTES): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const s = size(item);
    if (cur.length > 0 && (cur.length >= maxItems || bytes + s > maxBytes)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(item);
    bytes += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function classifyHttpStatus(status: number): HttpClass {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'permanent'; // 3xx (redirects are never followed), 400, 404, 413, 422 …
}

/** Exponential backoff: 1, 2, 4 … capped at 60 minutes. `rand` is injectable for tests. */
export function nextAttemptDelayMs(failures: number, rand: () => number = Math.random): number {
  const base = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.85 + rand() * 0.3));
}

export function statusAfterFailure(klass: HttpClass, failures: number): 'degraded' | 'failing' | 'auth_failed' {
  if (klass === 'auth') return 'auth_failed';
  return failures >= MAX_CONSECUTIVE_FAILURES ? 'failing' : 'degraded';
}

export function sanitizeError(message: string, secret: string): string {
  let m = message ?? '';
  if (secret) m = m.split(secret).join('***');
  return m.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function syntheticTestEvent(accountId: string, nowIso: string, id: string): SiemEvent {
  return {
    id,
    time: nowIso,
    account_id: accountId,
    action: 'siem_test_event',
    category: 'configuration',
    severity: 'info',
    actor: { id: null, email: null },
    target: { table: 'siem_destinations', id: null },
    metadata: { note: 'Test event sent from Vireek. Safe to ignore.' },
  };
}
