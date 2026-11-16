// src/lib/supportAgent/diagnostics.ts
//
// LEVEL 1 — Guided Troubleshooting. Pure, deterministic, dependency-injected:
//   collectEvidence(deps)  → what we can actually observe (no PII, no tokens)
//   analyze(evidence)      → ranked findings with cause, steps and allowed actions
// No LLM is involved here, so a diagnosis is reproducible and testable. The LLM
// (Ask tab) only receives a short sanitized summary of the result.

import type { IssueKind } from './errorBuffer';

export type Severity = 'critical' | 'warning' | 'info';
export type Confidence = 'high' | 'medium' | 'low';
export type ActionId =
  | 'refresh_session'
  | 'clear_app_cache'
  | 'resend_verification'
  | 'send_password_reset'
  | 'reload_app'
  | 'open_live_chat';

export interface Evidence {
  online: boolean;
  backend: 'reachable' | 'unreachable' | 'misconfigured' | 'unknown';
  backendLatencyMs: number | null;
  clockSkewSec: number | null;
  session: 'none' | 'valid' | 'expiring' | 'expired' | 'unknown';
  emailConfirmed: boolean | null;
  storage: 'ok' | 'blocked';
  secureContext: boolean;
  serviceWorkers: number;
  caches: number;
  issues: { kind: IssueKind; count: number }[];
}

export interface Finding {
  id: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  cause: string;
  steps: string[];
  actions: ActionId[];
}

export interface EvidenceDeps {
  now(): number;
  isOnline(): boolean;
  configured: boolean;
  ping(timeoutMs: number): Promise<{ ok: boolean; ms: number; serverDate: string | null }>;
  getSession(): Promise<{ expiresAtSec: number | null; emailConfirmed: boolean | null } | null>;
  storageWorks(): boolean;
  secureContext: boolean;
  countServiceWorkers(): Promise<number>;
  countCaches(): Promise<number>;
  issues(): { kind: IssueKind; count: number }[];
}

const EXPIRING_WITHIN_SEC = 120;
const CLOCK_SKEW_LIMIT_SEC = 120;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

export async function collectEvidence(deps: EvidenceDeps): Promise<Evidence> {
  const online = deps.isOnline();
  const nowMs = deps.now();

  const [ping, session, serviceWorkers, caches] = await Promise.all([
    !deps.configured || !online
      ? Promise.resolve(null)
      : safe(() => deps.ping(4_000), { ok: false, ms: 0, serverDate: null }),
    safe(() => deps.getSession(), undefined as undefined | null | { expiresAtSec: number | null; emailConfirmed: boolean | null }),
    safe(() => deps.countServiceWorkers(), 0),
    safe(() => deps.countCaches(), 0),
  ]);

  let backend: Evidence['backend'] = 'unknown';
  if (!deps.configured) backend = 'misconfigured';
  else if (ping) backend = ping.ok ? 'reachable' : 'unreachable';

  let clockSkewSec: number | null = null;
  if (ping?.ok && ping.serverDate) {
    const serverMs = Date.parse(ping.serverDate);
    if (Number.isFinite(serverMs)) clockSkewSec = Math.round((nowMs - serverMs) / 1000);
  }

  let sessionState: Evidence['session'] = 'unknown';
  if (session === null) sessionState = 'none';
  else if (session) {
    if (session.expiresAtSec == null) sessionState = 'valid';
    else {
      const left = session.expiresAtSec - nowMs / 1000;
      sessionState = left <= 0 ? 'expired' : left <= EXPIRING_WITHIN_SEC ? 'expiring' : 'valid';
    }
  }

  return {
    online,
    backend,
    backendLatencyMs: ping?.ok ? ping.ms : null,
    clockSkewSec,
    session: sessionState,
    emailConfirmed: session ? session.emailConfirmed : null,
    storage: deps.storageWorks() ? 'ok' : 'blocked',
    secureContext: deps.secureContext,
    serviceWorkers,
    caches,
    issues: deps.issues(),
  };
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const count = (e: Evidence, kind: IssueKind) => e.issues.find((i) => i.kind === kind)?.count ?? 0;

export function analyze(e: Evidence): Finding[] {
  const out: Finding[] = [];

  if (!e.online) {
    out.push({
      id: 'offline', severity: 'critical', confidence: 'high',
      title: 'Your device is offline',
      cause: 'The browser reports no network connection, so nothing can reach Vireek.',
      steps: ['Check Wi-Fi or mobile data, and turn off airplane mode.', 'Once you are back online this page re-checks automatically.'],
      actions: [],
    });
    // Root-cause suppression: while offline, backend / session / network findings are noise.
    return out;
  }

  if (e.backend === 'misconfigured') {
    out.push({
      id: 'backend_misconfigured', severity: 'critical', confidence: 'high',
      title: 'This site is not connected to its backend',
      cause: 'The app is missing its connection settings, so sign-in and data requests cannot work. This is a configuration problem on our side, not yours.',
      steps: ['Reload once. If it persists, contact the team with the report below.'],
      actions: ['reload_app', 'open_live_chat'],
    });
  } else if (e.backend === 'unreachable') {
    out.push({
      id: 'backend_unreachable', severity: 'critical', confidence: 'medium',
      title: 'We cannot reach the Vireek service from this browser',
      cause: 'Your device is online, but the request to our service failed. Either the service is briefly unavailable, or a VPN, firewall, ad-blocker or privacy extension is blocking it.',
      steps: ['Disable VPN / content-blocking extensions for this site and retry.', 'Try another network (for example mobile data) or another browser.', 'If it still fails, send us the report below.'],
      actions: ['reload_app', 'open_live_chat'],
    });
  }

  if (e.clockSkewSec != null && Math.abs(e.clockSkewSec) > CLOCK_SKEW_LIMIT_SEC) {
    out.push({
      id: 'clock_skew', severity: 'warning', confidence: 'high',
      title: 'Your device clock is off',
      cause: `Your clock differs from our server by about ${Math.round(Math.abs(e.clockSkewSec) / 60)} minutes. Sign-in tokens are time-based, so a wrong clock can make valid logins fail.`,
      steps: ['Turn on automatic date & time (and time zone) in your device settings.', 'Reload this page and try again.'],
      actions: ['reload_app'],
    });
  }

  if (e.session === 'expired') {
    out.push({
      id: 'session_expired', severity: 'warning', confidence: 'high',
      title: 'Your sign-in session has expired',
      cause: 'The access token on this device is past its expiry time.',
      steps: ['We can try to renew it automatically. If renewal fails, sign in again.'],
      actions: ['refresh_session'],
    });
  } else if (e.session === 'expiring') {
    out.push({
      id: 'session_expiring', severity: 'info', confidence: 'high',
      title: 'Your session is about to expire',
      cause: 'The access token expires within two minutes.',
      steps: ['Renewing now avoids a surprise sign-out.'],
      actions: ['refresh_session'],
    });
  }

  if (e.emailConfirmed === false || count(e, 'auth_email_unconfirmed') > 0) {
    out.push({
      id: 'email_unconfirmed', severity: 'warning', confidence: 'high',
      title: 'Your email address is not verified yet',
      cause: 'Sign-in is blocked until the verification email is confirmed.',
      steps: ['Open the latest verification email (check spam / promotions).', 'Or request a new one below.'],
      actions: ['resend_verification'],
    });
  }

  if (count(e, 'auth_invalid_credentials') > 0) {
    out.push({
      id: 'invalid_credentials', severity: 'warning', confidence: 'medium',
      title: 'The email or password was not accepted',
      cause: 'The last sign-in attempt was rejected. For security we cannot say which of the two was wrong, or whether an account exists for an address.',
      steps: ['Check the email spelling, Caps Lock and your password manager entry.', 'If unsure, reset the password with the button below.'],
      actions: ['send_password_reset'],
    });
  }

  if (count(e, 'auth_rate_limited') > 0) {
    out.push({
      id: 'rate_limited', severity: 'warning', confidence: 'high',
      title: 'Too many attempts in a short time',
      cause: 'Our protection temporarily limits repeated sign-in or email requests.',
      steps: ['Wait about 10 minutes before trying again — retrying now extends the wait.'],
      actions: [],
    });
  }

  if (count(e, 'chunk_load') > 0) {
    out.push({
      id: 'stale_app', severity: 'warning', confidence: e.caches > 0 || e.serviceWorkers > 0 ? 'high' : 'medium',
      title: 'This tab is running an outdated version of the app',
      cause: 'A new version was released and this tab failed to load a file from the old one.',
      steps: ['Clear the temporary app files and reload (you stay signed in).'],
      actions: ['clear_app_cache', 'reload_app'],
    });
  }

  if (e.storage === 'blocked') {
    out.push({
      id: 'storage_blocked', severity: 'warning', confidence: 'high',
      title: 'Your browser is blocking site storage',
      cause: 'Vireek cannot save your sign-in on this device — typically private mode or blocked cookies / site data.',
      steps: ['Leave private / incognito mode, or allow cookies and site data for this site.', 'Reload and sign in again.'],
      actions: ['reload_app'],
    });
  }

  if (e.backend === 'reachable' && count(e, 'network') >= 2) {
    out.push({
      id: 'flaky_network', severity: 'info', confidence: 'medium',
      title: 'Your connection looks unstable',
      cause: 'Several requests failed even though our service is reachable.',
      steps: ['Move closer to your router or switch networks, then reload.'],
      actions: ['reload_app'],
    });
  }

  if (out.length === 0) {
    out.push({
      id: 'healthy', severity: 'info', confidence: 'medium',
      title: 'No problems detected',
      cause: 'Connection, sign-in session, browser storage and recent errors all look normal.',
      steps: ['Describe what is going wrong in the Ask tab, or talk to our team.'],
      actions: ['open_live_chat'],
    });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export interface ReportContext {
  incidentId: string;
  timeIso: string;
  path: string;
  userAgent: string;
}

/** Copy-paste report for humans. Contains no email, token or query string. */
export function buildReport(e: Evidence, findings: Finding[], ctx: ReportContext): string {
  return [
    'Vireek diagnostic report',
    `Incident ID: ${ctx.incidentId}`,
    `Time: ${ctx.timeIso}`,
    `Page: ${ctx.path}`,
    `Browser: ${ctx.userAgent.slice(0, 120)}`,
    `Online: ${e.online} | Backend: ${e.backend}${e.backendLatencyMs != null ? ` (${e.backendLatencyMs} ms)` : ''}`,
    `Session: ${e.session} | Storage: ${e.storage} | Secure context: ${e.secureContext}`,
    `Clock skew: ${e.clockSkewSec == null ? 'unknown' : `${e.clockSkewSec}s`}`,
    `Recent issues: ${e.issues.length ? e.issues.map((i) => `${i.kind}×${i.count}`).join(', ') : 'none'}`,
    `Findings: ${findings.map((f) => `${f.id}(${f.confidence})`).join(', ')}`,
  ].join('\n');
}

/** ≤ 600 chars, structured, no free text from the user — safe to hand to the LLM as untrusted data. */
export function summarizeForAi(e: Evidence, findings: Finding[]): string {
  const parts = [
    `online=${e.online}`, `backend=${e.backend}`, `session=${e.session}`, `storage=${e.storage}`,
    `findings=${findings.map((f) => f.id).join(',')}`,
  ];
  if (e.issues.length) parts.push(`issues=${e.issues.map((i) => `${i.kind}x${i.count}`).join(',')}`);
  return parts.join('; ').slice(0, 600);
}
