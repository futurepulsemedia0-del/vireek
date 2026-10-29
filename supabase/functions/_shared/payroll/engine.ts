// supabase/functions/_shared/payroll/engine.ts
//
// Payroll provider integrations: pure and deterministic. NO database, NO Deno/DOM APIs (only fetch +
// WebCrypto). Imported by the edge functions, by the React client (provider catalog, state machine,
// formatting) and by the unit tests.
//
//   Catalog     : providers + honest availability
//   Settings    : earning-code names + approval policy
//   Batch       : status machine shared with the SQL RPCs
//   Matching    : suggest Vireek employee <-> provider employee links (never auto-confirmed)
//   OAuth state : signed, 10 minute lifetime
//   Sync        : provider-agnostic orchestration (adapter + store are injected, so it is mock-testable)
//
// Integrity rules:
//   1. Money is integer cents in Vireek and becomes a decimal string only at the provider edge.
//   2. Adapters SET values (never add), so re-sending the same batch cannot double pay.
//   3. Nothing here finalises a payroll at a provider.
//   4. Every provider error becomes a stable code + plain-language message, never a raw response body.

import { b64url, b64urlDecode, decryptSecret, encryptSecret } from '../crm/engine.ts';

export { decryptSecret, encryptSecret };

// ============================================================
// CATALOG
// ============================================================

export const PAYROLL_PROVIDERS = ['gusto', 'adp', 'paychex', 'quickbooks_payroll'] as const;
export type PayrollProvider = (typeof PAYROLL_PROVIDERS)[number];
export type ProviderAvailability = 'live_unverified' | 'planned';

export interface ProviderMeta {
  label: string;
  availability: ProviderAvailability;
  summary: string;
  /** What has to be true before this can be switched on. */
  note: string;
}

export const PROVIDER_META: Record<PayrollProvider, ProviderMeta> = {
  gusto: {
    label: 'Gusto',
    availability: 'live_unverified',
    summary: 'Fills hours, overtime and commissions on your next unprocessed Gusto payroll. You still review and run it in Gusto.',
    note: 'Built against Gusto’s public API and covered by mock tests. Not live-verified: test with a Gusto demo company first.',
  },
  adp: {
    label: 'ADP',
    availability: 'planned',
    summary: 'Hours, overtime and commissions to ADP Workforce Now.',
    note: 'Planned. ADP requires partner onboarding and a client certificate before any API call can be made.',
  },
  paychex: {
    label: 'Paychex',
    availability: 'planned',
    summary: 'Hours, overtime and commissions to Paychex Flex.',
    note: 'Planned. Requires Paychex Flex partner API access.',
  },
  quickbooks_payroll: {
    label: 'QuickBooks Payroll',
    availability: 'planned',
    summary: 'Hours, overtime and commissions to QuickBooks Payroll.',
    note: 'Planned. Needs Intuit partner approval for payroll data. Until then use the CSV export.',
  },
};

export const isPayrollProvider = (v: unknown): v is PayrollProvider => typeof v === 'string' && (PAYROLL_PROVIDERS as readonly string[]).includes(v);
export const isProviderLive = (p: PayrollProvider): boolean => PROVIDER_META[p].availability === 'live_unverified';

// ============================================================
// SETTINGS
// ============================================================

export interface PayrollSettings {
  regular_name: string;
  overtime_name: string;
  commission_name: string;
  require_separate_approver: boolean;
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  regular_name: 'Regular Hours',
  overtime_name: 'Overtime',
  commission_name: 'Commission',
  require_separate_approver: false,
};

export function normalizeSettings(raw: unknown): PayrollSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = (v: unknown, fallback: string): string => {
    const s = typeof v === 'string' ? v.trim().slice(0, 60) : '';
    return s || fallback;
  };
  return {
    regular_name: name(o.regular_name, DEFAULT_PAYROLL_SETTINGS.regular_name),
    overtime_name: name(o.overtime_name, DEFAULT_PAYROLL_SETTINGS.overtime_name),
    commission_name: name(o.commission_name, DEFAULT_PAYROLL_SETTINGS.commission_name),
    require_separate_approver: o.require_separate_approver === true,
  };
}

// ============================================================
// BATCH STATUS MACHINE (mirrors transition_payroll_sync_batch)
// ============================================================

export type BatchStatus = 'draft' | 'pending_approval' | 'approved' | 'syncing' | 'synced' | 'partial' | 'failed' | 'cancelled';
export type BatchAction = 'submit' | 'approve' | 'return' | 'cancel';

export const BATCH_ACTIONS: Record<BatchStatus, BatchAction[]> = {
  draft: ['submit', 'cancel'],
  pending_approval: ['approve', 'return', 'cancel'],
  approved: ['cancel'],
  syncing: [],
  synced: [],
  partial: [],
  failed: ['cancel'],
  cancelled: [],
};

export const canBatchTransition = (status: BatchStatus, action: BatchAction): boolean => BATCH_ACTIONS[status].includes(action);
/** A batch can be (re)sent once it is approved, or after a partial / failed attempt. */
export const canSendBatch = (status: BatchStatus): boolean => status === 'approved' || status === 'partial' || status === 'failed';

// ============================================================
// FORMATTING
// ============================================================

export const centsToAmount = (cents: number): string => (Math.round(cents) / 100).toFixed(2);
export const hoursToString = (hours: number): string => (Math.round(hours * 1000) / 1000).toFixed(3);
export const sameHours = (a: unknown, b: number): boolean => Math.abs(Number(a) - b) < 0.0005;
export const sameAmount = (a: unknown, cents: number): boolean => Math.abs(Math.round(Number(a) * 100) - Math.round(cents)) < 1;

// ============================================================
// EMPLOYEE MATCHING
// ============================================================

export interface ExternalEmployee {
  id: string;
  name: string;
  email: string | null;
  terminated: boolean;
}
export interface LinkSuggestion {
  employee_id: string;
  external_id: string;
  external_name: string;
}

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKey(s: string): string {
  const n = normalizeName(s);
  if (n.includes(',')) {
    const [last, first] = n.split(',').map((p) => p.trim());
    return `${first ?? ''} ${last ?? ''}`.trim();
  }
  return n;
}

/**
 * Suggest links by EXACT normalised full name only. A name that is ambiguous on either side is never
 * suggested. Suggestions are stored unconfirmed; a person must confirm before anything is sent.
 */
export function suggestLinks(
  employees: { id: string; full_name: string }[],
  external: ExternalEmployee[],
  linkedEmployeeIds: ReadonlySet<string>,
  linkedExternalIds: ReadonlySet<string>,
): LinkSuggestion[] {
  const byName = new Map<string, ExternalEmployee[]>();
  for (const x of external) {
    if (x.terminated || linkedExternalIds.has(x.id)) continue;
    const k = nameKey(x.name);
    if (k) byName.set(k, [...(byName.get(k) ?? []), x]);
  }
  const empCount = new Map<string, number>();
  for (const e of employees) empCount.set(nameKey(e.full_name), (empCount.get(nameKey(e.full_name)) ?? 0) + 1);

  const out: LinkSuggestion[] = [];
  for (const e of employees) {
    if (linkedEmployeeIds.has(e.id)) continue;
    const k = nameKey(e.full_name);
    const hits = byName.get(k);
    if (!k || !hits || hits.length !== 1 || empCount.get(k) !== 1) continue;
    out.push({ employee_id: e.id, external_id: hits[0].id, external_name: hits[0].name });
  }
  return out;
}

// ============================================================
// OAUTH STATE (signed, 10 minutes)
// ============================================================

export interface PayrollOAuthState {
  o: string;
  u: string;
  p: PayrollProvider;
  n: string;
  t: number;
}
const STATE_TTL_MS = 10 * 60 * 1000;

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

export async function signPayrollState(data: { owner: string; user: string; provider: PayrollProvider }, secret: string, now: number = Date.now()): Promise<string> {
  const payload: PayrollOAuthState = { o: data.owner, u: data.user, p: data.provider, n: b64url(crypto.getRandomValues(new Uint8Array(16))), t: now };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

export async function verifyPayrollState(state: string, secret: string, now: number = Date.now()): Promise<PayrollOAuthState | null> {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(await hmac(secret, body));
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as PayrollOAuthState;
    if (typeof p.o !== 'string' || typeof p.u !== 'string' || typeof p.n !== 'string' || !isPayrollProvider(p.p)) return null;
    if (!Number.isFinite(p.t) || now - p.t > STATE_TTL_MS || p.t - now > 60_000) return null;
    return p;
  } catch {
    return null;
  }
}

// ============================================================
// PROVIDER ERRORS
// ============================================================

export type ProviderErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'conflict'
  | 'validation'
  | 'bad_response'
  | 'no_matching_payroll'
  | 'ambiguous_payroll'
  | 'payroll_processed'
  | 'period_mismatch'
  | 'network';

export const PROVIDER_ERROR_COPY: Record<ProviderErrorCode, string> = {
  unauthorized: 'The payroll provider rejected our access. Reconnect it from the Connection tab.',
  forbidden: 'Your payroll-provider account is not allowed to do this. Check that the connected user is a payroll admin.',
  not_found: 'The payroll provider could not find that company, employee or payroll.',
  rate_limited: 'The payroll provider is rate limiting requests. Wait a minute and send again.',
  server_error: 'The payroll provider had a temporary problem. Send again in a few minutes.',
  conflict: 'The payroll was changed at the provider while we were sending. Send again to pick up the latest version.',
  validation: 'The payroll provider rejected these values.',
  bad_response: 'The payroll provider returned something we could not understand. Nothing was marked as sent.',
  no_matching_payroll: 'No open (unprocessed) payroll at the provider covers this pay period. Create or open the pay period there, then send again.',
  ambiguous_payroll: 'More than one open payroll at the provider covers this pay period. Pick the right one and send again.',
  payroll_processed: 'That payroll is already processed at the provider, so it can no longer be changed.',
  period_mismatch: 'The selected provider payroll does not cover this batch’s pay period.',
  network: 'We could not reach the payroll provider. Send again in a few minutes.',
};

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly detail: string | null = null,
    public readonly status: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(PROVIDER_ERROR_COPY[code]);
    this.name = 'ProviderError';
  }
}

export function classifyHttpStatus(status: number): ProviderErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'validation';
}

/** Pull a short, safe message out of a provider error body (never the whole body). */
export function safeErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const bits: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) bits.push(v.trim());
  };
  push(o.message);
  push(o.error);
  push(o.error_description);
  if (Array.isArray(o.errors)) {
    for (const e of o.errors.slice(0, 3)) {
      if (e && typeof e === 'object') {
        const eo = e as Record<string, unknown>;
        push(eo.message);
        push(eo.error_key);
      } else push(e);
    }
  }
  const s = bits.join('; ').replace(/\s+/g, ' ').slice(0, 240);
  return s || null;
}

// ============================================================
// SYNC ORCHESTRATION
// ============================================================

export interface ClaimedLine {
  line_id: string;
  employee_id: string;
  employee_name: string;
  external_employee_id: string;
  regular_hours: number;
  overtime_hours: number;
  commission_cents: number;
  send_hours: boolean;
  line_hash: string;
}

export interface ClaimedBatch {
  batch: { id: string; provider: PayrollProvider; period_start: string; period_end: string; external_payroll_id: string | null; connection_id: string };
  settings: PayrollSettings;
  external_company_id: string | null;
  environment: 'production' | 'sandbox';
  lines: ClaimedLine[];
}

export type LineStatus = 'sent' | 'unchanged' | 'failed';
export interface LineOutcome {
  line_id: string;
  status: LineStatus;
  external_ref?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface ProviderPayrollRef {
  id: string;
  label: string;
}

export interface PayrollProviderAdapter {
  /** Find (or validate) the open provider pay period that receives this batch. Throws ProviderError. */
  resolvePayroll(batch: ClaimedBatch, requestedPayrollId: string | null): Promise<ProviderPayrollRef>;
  /** Send every line. MUST be idempotent: set values, never add to them. Throws ProviderError for whole-request failures. */
  pushLines(payroll: ProviderPayrollRef, batch: ClaimedBatch): Promise<LineOutcome[]>;
}

export interface SyncStore {
  record(outcome: LineOutcome): Promise<void>;
  /** Returns the final batch status computed by the database. */
  finish(error: string | null, externalPayrollId: string | null): Promise<string>;
}

export interface SyncResult {
  status: string;
  error: string | null;
  payroll: ProviderPayrollRef | null;
  counts: { sent: number; unchanged: number; failed: number };
}

const messageOf = (e: unknown): { code: string; message: string } =>
  e instanceof ProviderError
    ? { code: e.code, message: e.detail ? `${e.message} (${e.detail})` : e.message }
    : { code: 'unexpected', message: 'Something unexpected went wrong while sending. Nothing further was changed.' };

export async function runSync(claimed: ClaimedBatch, adapter: PayrollProviderAdapter, store: SyncStore, requestedPayrollId: string | null): Promise<SyncResult> {
  const counts = { sent: 0, unchanged: 0, failed: 0 };
  const seen = new Set<string>();
  const record = async (o: LineOutcome) => {
    if (seen.has(o.line_id)) return;
    seen.add(o.line_id);
    counts[o.status] += 1;
    await store.record(o);
  };
  const failRest = async (code: string, message: string) => {
    for (const l of claimed.lines) if (!seen.has(l.line_id)) await record({ line_id: l.line_id, status: 'failed', error_code: code, error_message: message });
  };

  let payroll: ProviderPayrollRef | null = null;
  let error: string | null = null;
  try {
    payroll = await adapter.resolvePayroll(claimed, requestedPayrollId ?? claimed.batch.external_payroll_id);
    const outcomes = await adapter.pushLines(payroll, claimed);
    const known = new Set(claimed.lines.map((l) => l.line_id));
    for (const o of outcomes) if (known.has(o.line_id)) await record(o);
    await failRest('no_result', 'The provider did not confirm this line.');
  } catch (e) {
    const m = messageOf(e);
    error = m.message;
    await failRest(m.code, m.message);
  }
  if (!error && counts.failed > 0) error = `${counts.failed} line${counts.failed === 1 ? '' : 's'} could not be sent.`;
  const status = await store.finish(error, payroll?.id ?? null);
  return { status, error, payroll, counts };
}
