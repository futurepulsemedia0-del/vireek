/**
 * "Report a problem" diagnostics. Collects only what support needs: route (path only), the last
 * few client errors (scrubbed), and call/job ids read from the route. No query strings, no tokens,
 * no form values, no phone numbers/emails.
 */

export interface CapturedError { at: string; message: string }
export interface Diagnostics {
  route: string;
  call_id: string | null;
  job_id: string | null;
  recent_errors: CapturedError[];
  online: boolean;
  user_agent: string;
  captured_at: string;
}

const MAX_ERRORS = 5;
const MAX_MSG = 200;
const buffer: CapturedError[] = [];
let installed = false;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g;
const BEARER = /bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Removes secrets/PII-looking substrings and truncates. Order matters: JWT before generic tokens. */
export function scrub(input: unknown): string {
  const raw = typeof input === 'string' ? input : input instanceof Error ? input.message : String(input ?? '');
  return raw
    .replace(JWT, '[token]')
    .replace(BEARER, 'Bearer [token]')
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[number]')
    .replace(LONG_TOKEN, '[token]')
    .replace(/[?#]\S*/g, '')
    .slice(0, MAX_MSG);
}

export function recordError(message: unknown, now: Date = new Date()): void {
  const m = scrub(message);
  if (!m) return;
  buffer.push({ at: now.toISOString(), message: m });
  if (buffer.length > MAX_ERRORS) buffer.shift();
}

/** Idempotent. Call once at module load of the dock. */
export function installErrorCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => recordError(e.message));
  window.addEventListener('unhandledrejection', (e) => recordError((e.reason as unknown) ?? 'Unhandled promise rejection'));
}

export function clearCapturedErrors(): void { buffer.length = 0; }

/** Extracts the id after /calls/ or /jobs/ only if it is a real UUID. */
export function idFromPath(pathname: string, segment: 'calls' | 'jobs'): string | null {
  const parts = pathname.split('/').filter(Boolean);
  const i = parts.lastIndexOf(segment);
  const id = i >= 0 ? parts[i + 1] : undefined;
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

export function buildDiagnostics(pathname: string, now: Date = new Date()): Diagnostics {
  const route = pathname.split(/[?#]/)[0].slice(0, 200);
  return {
    route,
    call_id: idFromPath(route, 'calls'),
    job_id: idFromPath(route, 'jobs'),
    recent_errors: [...buffer],
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    user_agent: typeof navigator === 'undefined' ? '' : navigator.userAgent.slice(0, 160),
    captured_at: now.toISOString(),
  };
}

/** Human-readable block appended to the ticket body so the customer sees exactly what is sent. */
export function diagnosticsToText(d: Diagnostics): string {
  const lines = [
    '--- Diagnostics (auto-attached) ---',
    `Page: ${d.route}`,
    d.call_id ? `Call ID: ${d.call_id}` : null,
    d.job_id ? `Job ID: ${d.job_id}` : null,
    `Online: ${d.online ? 'yes' : 'no'}`,
    d.recent_errors.length ? `Recent errors:\n${d.recent_errors.map((e) => `  ${e.at} ${e.message}`).join('\n')}` : 'Recent errors: none captured',
  ];
  return lines.filter(Boolean).join('\n');
}
