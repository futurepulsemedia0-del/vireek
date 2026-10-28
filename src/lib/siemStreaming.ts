import { supabase } from '@/lib/supabase';
import type { PlanId } from '@/lib/pricing';

/**
 * SIEM log streaming (Splunk HEC / Datadog Logs) — client helpers.
 *
 * Reads go through RLS (owner-only SELECT on siem_destinations / siem_delivery_log).
 * Every write goes through the `siem-stream` edge function, which encrypts the token,
 * enforces owner + plan server-side and writes the audit trail. The token is never
 * readable from the browser after it has been saved.
 */

export type SiemProvider = 'splunk_hec' | 'datadog';
export type SiemSeverity = 'info' | 'low' | 'medium' | 'high';
export type SiemStatus = 'active' | 'degraded' | 'failing' | 'auth_failed';

export const SIEM_PLANS: PlanId[] = ['business', 'enterprise'];
export const MAX_DESTINATIONS = 5;

export function isSiemEligible(plan: PlanId | string | null | undefined, isOwner: boolean): boolean {
  return isOwner && SIEM_PLANS.includes(plan as PlanId);
}

/** Keep in sync with DATADOG_SITES in supabase/functions/_shared/siem/engine.ts. */
export const DATADOG_SITES: { value: string; label: string }[] = [
  { value: 'datadoghq.com', label: 'US1 · datadoghq.com' },
  { value: 'us3.datadoghq.com', label: 'US3 · us3.datadoghq.com' },
  { value: 'us5.datadoghq.com', label: 'US5 · us5.datadoghq.com' },
  { value: 'datadoghq.eu', label: 'EU · datadoghq.eu' },
  { value: 'ap1.datadoghq.com', label: 'AP1 · ap1.datadoghq.com' },
  { value: 'ap2.datadoghq.com', label: 'AP2 · ap2.datadoghq.com' },
  { value: 'ddog-gov.com', label: 'US1-FED · ddog-gov.com' },
];

export const SEVERITY_OPTIONS: { value: SiemSeverity; label: string; hint: string }[] = [
  { value: 'info', label: 'All events', hint: 'Everything in the audit log' },
  { value: 'low', label: 'Low and above', hint: 'Skip purely informational events' },
  { value: 'medium', label: 'Medium and above', hint: 'Deletions, role and access changes' },
  { value: 'high', label: 'High only', hint: 'MFA, SSO, security policy, exports' },
];

export const PROVIDER_META: Record<SiemProvider, { label: string; tokenLabel: string; description: string }> = {
  splunk_hec: {
    label: 'Splunk (HTTP Event Collector)',
    tokenLabel: 'HEC token',
    description: 'Send events to a Splunk Cloud or Splunk Enterprise HTTP Event Collector.',
  },
  datadog: {
    label: 'Datadog Logs',
    tokenLabel: 'API key',
    description: 'Send events to Datadog Log Management as structured logs.',
  },
};

export interface SiemDestination {
  id: string;
  name: string;
  provider: SiemProvider;
  endpoint_url: string | null;
  datadog_site: string | null;
  splunk_index: string | null;
  splunk_sourcetype: string | null;
  min_severity: SiemSeverity;
  enabled: boolean;
  status: SiemStatus;
  next_attempt_at: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  events_sent_total: number;
  events_dropped_total: number;
  created_at: string;
  updated_at: string;
}

export interface SiemDeliveryLogRow {
  id: string;
  kind: 'delivery' | 'test';
  status: 'ok' | 'failed';
  event_count: number;
  dropped_count: number;
  http_status: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

const DEST_COLUMNS =
  'id, name, provider, endpoint_url, datadog_site, splunk_index, splunk_sourcetype, min_severity, enabled, status, next_attempt_at, consecutive_failures, last_success_at, last_error, last_error_at, events_sent_total, events_dropped_total, created_at, updated_at';
const LOG_COLUMNS = 'id, kind, status, event_count, dropped_count, http_status, error, duration_ms, created_at';

/* ------------------------------------------------------------------ */
/*  Form model + validation (mirrors the server rules)                  */
/* ------------------------------------------------------------------ */

export interface DestinationForm {
  provider: SiemProvider;
  name: string;
  url: string;
  site: string;
  index: string;
  sourcetype: string;
  secret: string;
  minSeverity: SiemSeverity;
}

export const EMPTY_FORM: DestinationForm = {
  provider: 'splunk_hec',
  name: '',
  url: '',
  site: 'datadoghq.com',
  index: '',
  sourcetype: '',
  secret: '',
  minSeverity: 'info',
};

export function formFromDestination(d: SiemDestination): DestinationForm {
  return {
    provider: d.provider,
    name: d.name,
    url: d.endpoint_url ?? '',
    site: d.datadog_site ?? 'datadoghq.com',
    index: d.splunk_index ?? '',
    sourcetype: d.splunk_sourcetype ?? '',
    secret: '',
    minSeverity: d.min_severity,
  };
}

export type FormErrors = Partial<Record<keyof DestinationForm, string>>;

function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (!host || host.includes(':') || host.startsWith('[')) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|internal|lan|intranet|corp|home|localdomain)$/.test(host)) return true;
  if (!host.includes('.')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

export function validateForm(form: DestinationForm, isEdit: boolean): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Give this destination a name.';
  else if (name.length > 80) errors.name = 'Keep the name under 80 characters.';

  if (form.provider === 'splunk_hec') {
    const raw = form.url.trim();
    if (!raw) errors.url = 'Enter your Splunk HEC URL.';
    else {
      try {
        const u = new URL(raw);
        const port = u.port ? Number(u.port) : 443;
        if (u.protocol !== 'https:') errors.url = 'The HEC URL must use https://.';
        else if (u.username || u.password) errors.url = 'Remove credentials from the URL; paste the token below.';
        else if (isPrivateHost(u.hostname)) errors.url = 'That host is not reachable from the public internet.';
        else if (!(port === 443 || (port >= 1024 && port <= 65535))) errors.url = 'Use port 443 or a port between 1024 and 65535.';
      } catch {
        errors.url = 'Enter a valid URL, e.g. https://http-inputs-acme.splunkcloud.com:443';
      }
    }
    if (form.index.trim() && !/^[a-zA-Z0-9_-]{1,80}$/.test(form.index.trim())) errors.index = 'Letters, numbers, - and _ only.';
    if (form.sourcetype.trim() && !/^[a-zA-Z0-9_:.-]{1,80}$/.test(form.sourcetype.trim())) errors.sourcetype = 'Letters, numbers, : . - and _ only.';
  } else if (!DATADOG_SITES.some((s) => s.value === form.site)) {
    errors.site = 'Choose your Datadog site.';
  }

  const secret = form.secret.trim();
  const label = PROVIDER_META[form.provider].tokenLabel;
  if (!secret) {
    if (!isEdit) errors.secret = `Enter your ${label}.`;
  } else if (secret.length < 8 || secret.length > 512 || /\s/.test(secret)) {
    errors.secret = `That ${label} doesn't look valid (8–512 characters, no spaces).`;
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/*  Presentation helpers                                                */
/* ------------------------------------------------------------------ */

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'never';
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  const unit = (n: number, s: string) => (diff < 0 ? `${n} ${s}${n === 1 ? '' : 's'} ago` : `in ${n} ${s}${n === 1 ? '' : 's'}`);
  if (abs < 45) return diff < 0 ? 'just now' : 'in a few seconds';
  if (abs < 3600) return unit(Math.max(1, Math.round(abs / 60)), 'minute');
  if (abs < 86_400) return unit(Math.round(abs / 3600), 'hour');
  return unit(Math.round(abs / 86_400), 'day');
}

export function describeStatus(d: Pick<SiemDestination, 'enabled' | 'status' | 'last_success_at' | 'next_attempt_at'>, now: number = Date.now()): { label: string; tone: StatusTone; hint: string } {
  if (!d.enabled) return { label: 'Paused', tone: 'neutral', hint: 'Streaming is paused. Events are kept and sent when you resume.' };
  switch (d.status) {
    case 'auth_failed':
      return { label: 'Needs attention', tone: 'danger', hint: 'The destination rejected our credentials or configuration. Edit it and re-enter the token.' };
    case 'failing':
      return { label: 'Failing', tone: 'danger', hint: `Delivery keeps failing. Next retry ${formatRelativeTime(d.next_attempt_at, now)}. No events are lost.` };
    case 'degraded':
      return { label: 'Retrying', tone: 'warning', hint: `Last delivery failed. Next retry ${formatRelativeTime(d.next_attempt_at, now)}. No events are lost.` };
    default:
      return d.last_success_at
        ? { label: 'Streaming', tone: 'success', hint: `Last delivery ${formatRelativeTime(d.last_success_at, now)}.` }
        : { label: 'Waiting for events', tone: 'neutral', hint: 'Connected. New security events will appear here once they occur.' };
  }
}

export function destinationTarget(d: Pick<SiemDestination, 'provider' | 'endpoint_url' | 'datadog_site'>): string {
  if (d.provider === 'datadog') return d.datadog_site ?? '';
  try {
    return new URL(d.endpoint_url ?? '').host;
  } catch {
    return d.endpoint_url ?? '';
  }
}

/* ------------------------------------------------------------------ */
/*  API                                                                 */
/* ------------------------------------------------------------------ */

export async function fetchDestinations(): Promise<SiemDestination[]> {
  const { data, error } = await supabase.from('siem_destinations').select(DEST_COLUMNS).order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SiemDestination[];
}

export async function fetchDeliveryLog(destinationId: string, limit = 15): Promise<SiemDeliveryLogRow[]> {
  const { data, error } = await supabase
    .from('siem_delivery_log')
    .select(LOG_COLUMNS)
    .eq('destination_id', destinationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SiemDeliveryLogRow[];
}

const GENERIC_ERROR = 'Something went wrong. Please try again.';

async function extractErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).clone === 'function') {
    try {
      const body = await (ctx as Response).clone().json();
      if (body && typeof body.error === 'string') return body.error;
    } catch {
      /* fall through */
    }
  }
  return GENERIC_ERROR;
}

async function invoke<T extends { ok?: boolean; error?: string }>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('siem-stream', { body: { action, ...payload } });
  if (error) throw new Error(await extractErrorMessage(error));
  if (data && typeof data.error === 'string' && data.ok === undefined) throw new Error(data.error);
  return (data ?? {}) as T;
}

export async function saveDestination(form: DestinationForm, id?: string): Promise<string> {
  const res = await invoke<{ ok?: boolean; id?: string; error?: string }>('save', {
    id,
    provider: form.provider,
    name: form.name.trim(),
    url: form.provider === 'splunk_hec' ? form.url.trim() : undefined,
    site: form.provider === 'datadog' ? form.site : undefined,
    index: form.provider === 'splunk_hec' ? form.index.trim() : undefined,
    sourcetype: form.provider === 'splunk_hec' ? form.sourcetype.trim() : undefined,
    secret: form.secret.trim() || undefined,
    min_severity: form.minSeverity,
  });
  if (!res.id) throw new Error(GENERIC_ERROR);
  return res.id;
}

export interface TestResult {
  ok: boolean;
  http_status?: number | null;
  duration_ms?: number;
  error?: string;
}

export const testDestination = (id: string) => invoke<TestResult>('test', { id });

export async function setDestinationEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke('set_enabled', { id, enabled });
}

export async function deleteDestination(id: string): Promise<void> {
  await invoke('delete', { id });
}

export const deliverNow = (id: string) => invoke<{ ok: boolean; sent?: number; dropped?: number; error?: string }>('deliver_now', { id });
