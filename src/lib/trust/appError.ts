/**
 * Typed error taxonomy. Every failure that reaches the UI is classified into
 * one of 8 kinds, each with ONE recovery action and an i18n message key.
 * Raw codes/messages never leave this module: the UI only receives
 * `messageKey` + `referenceId`. Pure (no React / Supabase imports).
 */
import { generateIncidentId } from '@/lib/incident';

export const APP_ERROR_KINDS = ['network', 'auth', 'permission', 'validation', 'conflict', 'rate_limit', 'server', 'unknown'] as const;
export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

export type RecoveryAction = 'retry' | 'fix_field' | 'sign_in' | 'refresh' | 'wait' | 'contact_support';

export interface AppError {
  kind: AppErrorKind;
  recovery: RecoveryAction;
  /** i18n key, e.g. `trust.error.network` (→ `.title` / `.body`). */
  messageKey: string;
  /** Always present, shown to the user and prefilled into the support email. */
  referenceId: string;
  /** Safe to retry automatically / with the Retry button. */
  retryable: boolean;
  retryAfterMs?: number;
  /** Per-field validation messages when the server supplied them. */
  fieldErrors?: Record<string, string>;
}

const RECOVERY: Record<AppErrorKind, RecoveryAction> = {
  network: 'retry',
  auth: 'sign_in',
  permission: 'contact_support',
  validation: 'fix_field',
  conflict: 'refresh',
  rate_limit: 'wait',
  server: 'retry',
  unknown: 'contact_support',
};

const RETRYABLE: Record<AppErrorKind, boolean> = {
  network: true,
  auth: false,
  permission: false,
  validation: false,
  conflict: false,
  rate_limit: true,
  server: true,
  unknown: false,
};

/** Thrown by `updateWithVersion` so callers can `instanceof` it. */
export class ConflictError extends Error {
  readonly current: Record<string, unknown> | null;
  constructor(current: Record<string, unknown> | null) {
    super('conflict');
    this.name = 'ConflictError';
    this.current = current;
  }
}

interface Loose {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  details?: unknown;
  retryAfter?: unknown;
  fieldErrors?: unknown;
}

const asLoose = (e: unknown): Loose => (typeof e === 'object' && e !== null ? (e as Loose) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const NETWORK_RE = /failed to fetch|networkerror|network request failed|load failed|fetch failed|econnreset|enotfound|timeout|timed out|offline|err_internet/i;
const AUTH_RE = /jwt|not authenticated|invalid.*token|session.*(missing|expired)|refresh token|auth session/i;
const PERMISSION_RE = /permission denied|row-level security|not authorized|forbidden|insufficient|do not have permission|violates row-level/i;
const CONFLICT_RE = /conflict|already exists|duplicate key|version mismatch|was modified/i;
const RATE_RE = /rate limit|too many requests/i;

const PG_VALIDATION = new Set(['22P02', '22001', '22003', '22007', '22008', '23502', '23503', '23514', '23P01', 'P0001', 'PGRST102']);

function kindFromStatus(status: number): AppErrorKind | null {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 422) return 'validation';
  if (status === 408 || status === 0) return 'network';
  if (status >= 500) return 'server';
  return null;
}

function kindFromCode(code: string): AppErrorKind | null {
  if (!code) return null;
  if (code === '42501') return 'permission';
  if (code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303') return 'auth';
  if (code === '23505' || code === '40001' || code === '40P01' || code === 'PGRST116') return 'conflict';
  if (PG_VALIDATION.has(code)) return 'validation';
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return 'rate_limit';
  if (code.startsWith('08') || code === '57014') return 'network';
  if (code.startsWith('XX') || code.startsWith('53') || code.startsWith('58')) return 'server';
  return null;
}

export function classifyKind(input: unknown, opts: { offline?: boolean } = {}): AppErrorKind {
  if (input instanceof ConflictError) return 'conflict';
  if (opts.offline) return 'network';
  const e = asLoose(input);
  const message = typeof input === 'string' ? input : str(e.message);
  const name = str(e.name);

  const status = Number(e.status ?? e.statusCode);
  const byStatus = Number.isFinite(status) ? kindFromStatus(status) : null;
  if (byStatus) return byStatus;

  const byCode = kindFromCode(str(e.code));
  if (byCode) return byCode;

  if (name === 'AbortError') return 'network';
  if (name === 'AuthSessionMissingError' || name === 'AuthApiError' || name === 'AuthRetryableFetchError') {
    return name === 'AuthRetryableFetchError' ? 'network' : 'auth';
  }
  if (name === 'TypeError' && NETWORK_RE.test(message)) return 'network';
  if (RATE_RE.test(message)) return 'rate_limit';
  if (NETWORK_RE.test(message)) return 'network';
  if (AUTH_RE.test(message)) return 'auth';
  if (PERMISSION_RE.test(message)) return 'permission';
  if (CONFLICT_RE.test(message)) return 'conflict';
  return 'unknown';
}

function readRetryAfterMs(e: Loose): number | undefined {
  const n = Number(e.retryAfter);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 1000), 300_000) : undefined;
}

function readFieldErrors(e: Loose): Record<string, string> | undefined {
  const fe = e.fieldErrors;
  if (!fe || typeof fe !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fe as Record<string, unknown>)) if (k && typeof v === 'string' && v) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

export function classifyError(
  input: unknown,
  opts: { referenceId?: string; offline?: boolean } = {},
): AppError {
  const offline = opts.offline ?? (typeof navigator !== 'undefined' && navigator.onLine === false);
  const kind = classifyKind(input, { offline });
  const loose = asLoose(input);
  const fieldErrors = kind === 'validation' ? readFieldErrors(loose) : undefined;
  return {
    kind,
    // Validation without field info can't point at a field: fall back to retry-free support path.
    recovery: kind === 'validation' && !fieldErrors ? 'fix_field' : RECOVERY[kind],
    messageKey: `trust.error.${kind}`,
    referenceId: opts.referenceId ?? generateIncidentId(),
    retryable: RETRYABLE[kind],
    retryAfterMs: kind === 'rate_limit' ? readRetryAfterMs(loose) ?? 5000 : undefined,
    fieldErrors,
  };
}

/** Type guard used by callers that may receive either a raw error or an already-classified one. */
export function isAppError(v: unknown): v is AppError {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<AppError>;
  return typeof o.kind === 'string' && (APP_ERROR_KINDS as readonly string[]).includes(o.kind) && typeof o.referenceId === 'string' && typeof o.messageKey === 'string';
}

export const toAppError = (v: unknown, opts?: { referenceId?: string }): AppError => (isAppError(v) ? v : classifyError(v, opts));
