// src/lib/supportAgent/errorBuffer.ts
//
// Privacy-safe ring buffer of the last client-side problems (JS errors, failed
// promises, auth failures). Feeds the Support Agent's log analysis. Never stores
// raw messages: emails, tokens, long ids and URL query strings are redacted first.
// Only ADDS listeners — never calls preventDefault, so Sentry / chunkRecovery /
// ErrorBoundary keep behaving exactly as before.

import { isChunkLoadError } from '@/lib/incident';

export type IssueKind =
  | 'chunk_load'
  | 'network'
  | 'auth_invalid_credentials'
  | 'auth_email_unconfirmed'
  | 'auth_rate_limited'
  | 'auth_session_expired'
  | 'script_error'
  | 'unhandled_rejection';

export interface CapturedIssue {
  at: number;
  kind: IssueKind;
  /** Redacted, max 160 chars. */
  message: string;
  count: number;
}

const MAX_ISSUES = 20;
const DEDUPE_MS = 5_000;
const MAX_MESSAGE = 160;

/** Strips anything that could identify a person or grant access. */
export function redact(input: string): string {
  return String(input ?? '')
    .replace(/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, '[token]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/https?:\/\/[^\s?#"')]+(?:[?#][^\s"')]*)?/gi, (u) => u.split(/[?#]/)[0])
    .replace(/\b[0-9a-f]{12,}\b/gi, '[id]')
    .replace(/\b\d{9,}\b/g, '[num]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE);
}

/** Order matters: the chunk check must run before the generic "failed to fetch" check. */
export function classifyIssue(message: string, name?: string): IssueKind | null {
  if (isChunkLoadError({ name, message })) return 'chunk_load';
  const m = message.toLowerCase();
  if (/email not confirmed|email_not_confirmed|confirm your email|not confirmed/.test(m)) return 'auth_email_unconfirmed';
  if (/invalid login|invalid email or password|invalid credentials|invalid_credentials/.test(m)) return 'auth_invalid_credentials';
  if (/rate limit|rate_limit|too many requests|\b429\b/.test(m)) return 'auth_rate_limited';
  if (/jwt expired|session (?:has )?expired|session not found|refresh token|token (?:is )?expired/.test(m)) return 'auth_session_expired';
  if (/failed to fetch|networkerror|network request failed|load failed|err_internet|err_network|timeout/.test(m)) return 'network';
  return null;
}

let issues: CapturedIssue[] = [];
let installed = false;
const listeners = new Set<(issue: CapturedIssue) => void>();

export function recordIssue(rawMessage: string, opts: { name?: string; fallback: IssueKind; now?: number }): CapturedIssue | null {
  const raw = String(rawMessage ?? '');
  if (!raw || /ResizeObserver loop/i.test(raw)) return null; // benign browser noise
  const kind = classifyIssue(raw, opts.name) ?? opts.fallback;
  const message = redact(raw);
  const now = opts.now ?? Date.now();
  const last = issues[issues.length - 1];
  if (last && last.kind === kind && last.message === message && now - last.at < DEDUPE_MS) {
    last.count += 1;
    last.at = now;
    return last;
  }
  const issue: CapturedIssue = { at: now, kind, message, count: 1 };
  issues = [...issues, issue].slice(-MAX_ISSUES);
  listeners.forEach((l) => {
    try { l(issue); } catch { /* a listener must never break error capture */ }
  });
  return issue;
}

export const getIssues = (): readonly CapturedIssue[] => issues;

/** Kind → total count, for reports and diagnostics. */
export function summarizeIssues(list: readonly CapturedIssue[] = issues): { kind: IssueKind; count: number }[] {
  const totals = new Map<IssueKind, number>();
  list.forEach((i) => totals.set(i.kind, (totals.get(i.kind) ?? 0) + i.count));
  return [...totals].map(([kind, count]) => ({ kind, count }));
}

export function subscribeIssues(fn: (issue: CapturedIssue) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearIssues(): void {
  issues = [];
}

/** Idempotent. Call once at boot (src/main.tsx). */
export function installErrorBuffer(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    recordIssue(e.error?.message ?? e.message ?? '', { name: e.error?.name, fallback: 'script_error' });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; name?: string } | string | undefined;
    const message = typeof r === 'string' ? r : r?.message ?? '';
    recordIssue(message, { name: typeof r === 'string' ? undefined : r?.name, fallback: 'unhandled_rejection' });
  });
  // Dispatched by LoginPage: window.dispatchEvent(new CustomEvent('vireek:auth-issue', { detail: { message } }))
  window.addEventListener('vireek:auth-issue', (e) => {
    const message = (e as CustomEvent<{ message?: string }>).detail?.message ?? '';
    recordIssue(message, { fallback: 'script_error' });
  });
}

/** Test helper. */
export function __resetForTests(): void {
  issues = [];
  listeners.clear();
  installed = false;
}
