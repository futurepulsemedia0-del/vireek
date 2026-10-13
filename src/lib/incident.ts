// Pure helpers for the 500 / incident experience: incident IDs, report form
// validation, support-email links and error-detail formatting. No React, no
// Sentry — everything here is unit-tested in incident.test.ts.

export const SUPPORT_EMAIL = 'ali@vireek.com';

/** 31 symbols: no I, L, O, 0 or 1, so an ID read over the phone is unambiguous. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INCIDENT_ID_RE = /^INC-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

function secureRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** `INC-7K3Q-9XMD`. Rejection sampling (248 = 31 × 8) keeps every symbol equally likely. */
export function generateIncidentId(random: (n: number) => Uint8Array = secureRandomBytes): string {
  let out = '';
  for (let round = 0; round < 50 && out.length < 8; round += 1) {
    for (const b of random(16)) {
      if (b < 248 && out.length < 8) out += ALPHABET[b % 31];
    }
  }
  return `INC-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export const isIncidentId = (s: string): boolean => INCIDENT_ID_RE.test(s);

/** Reads a valid `?incident=` value (case-insensitive), or null — arbitrary text is never trusted. */
export function readIncidentFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('incident')?.trim().toUpperCase() ?? '';
  return isIncidentId(raw) ? raw : null;
}

/** Errors thrown when a lazy-loaded chunk 404s after a new deploy — fixed by a reload. */
export function isChunkLoadError(error: { name?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (CSS )?chunk [\w-]+ failed/i.test(error.message ?? '');
}

export const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Origin + path only: query strings and hashes can carry tokens, so they never go into reports. */
export function safeUrl(href: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

export interface SupportMailInput { incidentId: string; url: string; time: string; message?: string | null }

export function buildSupportMailto({ incidentId, url, time, message }: SupportMailInput): string {
  const body = [
    'Hi Vireek team,',
    '',
    'I ran into an error.',
    `Incident ID: ${incidentId}`,
    url ? `Page: ${url}` : null,
    `Time: ${time}`,
    message ? `Error: ${truncate(message, 300)}` : null,
    '',
    'What I was doing:',
    '',
  ].filter((l): l is string => l !== null).join('\n');
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Vireek error ${incidentId}`)}&body=${encodeURIComponent(body)}`;
}

export interface ErrorDetailsInput {
  incidentId: string;
  error?: { message?: string; stack?: string } | null;
  componentStack?: string | null;
  url: string;
  time: string;
}

/** The text behind “Copy error details” — what support needs to reproduce the problem. */
export function formatErrorDetails({ incidentId, error, componentStack, url, time }: ErrorDetailsInput): string {
  return [
    `Incident ID: ${incidentId}`,
    `Message: ${error?.message ?? 'unknown'}`,
    error?.stack ? `Stack:\n${error.stack}` : null,
    componentStack ? `Component stack:${componentStack}` : null,
    url ? `URL: ${url}` : null,
    `Time: ${time}`,
  ].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Report form
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

export const REPORT_NOTE_MAX = 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Both fields are optional: a report with no note still tells us this incident mattered. */
export function parseReportForm(f: { note: string; email: string }): ParseResult<{ note: string; email: string | null }> {
  const errors: FieldErrors = {};
  const note = f.note.trim();
  const email = f.email.trim();
  if (note.length > REPORT_NOTE_MAX) errors.note = `Please keep it under ${REPORT_NOTE_MAX.toLocaleString()} characters.`;
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) errors.email = 'That email address doesn’t look right.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { note, email: email || null } };
}
