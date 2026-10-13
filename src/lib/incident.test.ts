import { describe, it, expect } from 'vitest';
import {
  INCIDENT_ID_RE, REPORT_NOTE_MAX, SUPPORT_EMAIL, buildSupportMailto, formatErrorDetails, generateIncidentId,
  isChunkLoadError, isIncidentId, parseReportForm, readIncidentFromSearch, safeUrl, truncate,
} from './incident';

describe('generateIncidentId', () => {
  it('has the INC-XXXX-XXXX shape and avoids ambiguous characters', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = generateIncidentId();
      expect(INCIDENT_ID_RE.test(id)).toBe(true);
      expect(/[ILO01]/.test(id.slice(4))).toBe(false);
    }
  });
  it('is deterministic for a given byte source and maps bytes onto the alphabet', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 30, 31, 32, 33, 34, 35, 36, 37]);
    expect(generateIncidentId(() => bytes)).toBe('INC-ABCD-EFGH');
  });
  it('skips biased bytes (>= 248) instead of wrapping them', () => {
    const calls: Uint8Array[] = [new Uint8Array(16).fill(250), new Uint8Array(16).fill(0)];
    expect(generateIncidentId(() => calls.shift() ?? new Uint8Array(16))).toBe('INC-AAAA-AAAA');
  });
  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateIncidentId()));
    expect(ids.size).toBe(500);
  });
});

describe('incident id parsing', () => {
  it('validates ids', () => {
    expect(isIncidentId('INC-7K3Q-9XMD')).toBe(true);
    expect(isIncidentId('INC-7K3Q-9XM0')).toBe(false);
    expect(isIncidentId('inc-7k3q-9xmd')).toBe(false);
    expect(isIncidentId('<script>')).toBe(false);
  });
  it('reads a valid ?incident= value, case-insensitively, and ignores junk', () => {
    expect(readIncidentFromSearch('?incident=inc-7k3q-9xmd')).toBe('INC-7K3Q-9XMD');
    expect(readIncidentFromSearch('?foo=1&incident=INC-7K3Q-9XMD')).toBe('INC-7K3Q-9XMD');
    expect(readIncidentFromSearch('?incident=<img src=x>')).toBeNull();
    expect(readIncidentFromSearch('')).toBeNull();
  });
});

describe('isChunkLoadError', () => {
  it('recognises stale-deploy chunk failures across browsers', () => {
    expect(isChunkLoadError({ message: 'Failed to fetch dynamically imported module: https://x/assets/a.js' })).toBe(true);
    expect(isChunkLoadError({ message: 'error loading dynamically imported module' })).toBe(true);
    expect(isChunkLoadError({ message: 'Importing a module script failed.' })).toBe(true);
    expect(isChunkLoadError({ message: 'Loading chunk 12 failed.' })).toBe(true);
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: 'x' })).toBe(true);
  });
  it('does not flag ordinary errors', () => {
    expect(isChunkLoadError({ message: 'Cannot read properties of undefined' })).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe('urls and text', () => {
  it('keeps only origin and path (no query, no hash)', () => {
    expect(safeUrl('https://vireek.com/dashboard/jobs?token=secret#x')).toBe('https://vireek.com/dashboard/jobs');
    expect(safeUrl('not a url')).toBe('');
  });
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

describe('buildSupportMailto', () => {
  it('addresses support and carries the incident id, page and time', () => {
    const href = buildSupportMailto({ incidentId: 'INC-7K3Q-9XMD', url: 'https://vireek.com/x', time: '2026-10-08T12:00:00.000Z', message: 'Boom' });
    expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`)).toBe(true);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('subject')).toBe('Vireek error INC-7K3Q-9XMD');
    const body = params.get('body') ?? '';
    expect(body).toContain('Incident ID: INC-7K3Q-9XMD');
    expect(body).toContain('Page: https://vireek.com/x');
    expect(body).toContain('Error: Boom');
  });
  it('omits empty parts and caps a very long message', () => {
    const body = new URLSearchParams(buildSupportMailto({ incidentId: 'INC-7K3Q-9XMD', url: '', time: 't', message: 'x'.repeat(5000) }).split('?')[1]).get('body') ?? '';
    expect(body).not.toContain('Page:');
    expect(body.length).toBeLessThan(600);
  });
});

describe('formatErrorDetails', () => {
  it('includes everything support needs, in order', () => {
    const text = formatErrorDetails({ incidentId: 'INC-7K3Q-9XMD', error: { message: 'Boom', stack: 'Error: Boom\n at x' }, componentStack: '\n in Foo', url: 'https://v/x', time: 't' });
    expect(text.startsWith('Incident ID: INC-7K3Q-9XMD')).toBe(true);
    expect(text).toContain('Message: Boom');
    expect(text).toContain('Stack:\nError: Boom');
    expect(text).toContain('Component stack:\n in Foo');
    expect(text).toContain('URL: https://v/x');
  });
  it('copes with a missing error', () => {
    expect(formatErrorDetails({ incidentId: 'INC-7K3Q-9XMD', url: '', time: 't' })).toContain('Message: unknown');
  });
});

describe('parseReportForm', () => {
  it('accepts an empty form (a bare report is still useful)', () => {
    expect(parseReportForm({ note: '  ', email: '' })).toEqual({ ok: true, value: { note: '', email: null } });
  });
  it('trims and keeps a valid note and email', () => {
    expect(parseReportForm({ note: ' It froze ', email: ' a@b.co ' })).toEqual({ ok: true, value: { note: 'It froze', email: 'a@b.co' } });
  });
  it('rejects a bad email and an over-long note', () => {
    const r = parseReportForm({ note: 'x'.repeat(REPORT_NOTE_MAX + 1), email: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['email', 'note']);
  });
});
