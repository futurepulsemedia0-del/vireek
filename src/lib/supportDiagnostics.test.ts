import { beforeEach, describe, expect, it } from 'vitest';
import { buildDiagnostics, clearCapturedErrors, diagnosticsToText, idFromPath, recordError, scrub } from './supportDiagnostics';

const U = '3f2b8c1e-9d4a-4c7e-8b21-0a1b2c3d4e5f';
beforeEach(() => clearCapturedErrors());

describe('scrub', () => {
  it('removes emails, phones, JWTs, bearer tokens, long tokens and query strings', () => {
    const s = scrub(`fail for a@b.com +1 (555) 123-4567 Bearer abcdefghijkl eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM key sk_live_abcdefghijklmnopqrstuvwxyz123456 /x?token=1`);
    expect(s).not.toMatch(/a@b\.com|555|abcdefghijkl|eyJ|sk_live|token=1/);
  });
  it('truncates to 200 chars', () => { expect(scrub('x '.repeat(500)).length).toBeLessThanOrEqual(200); });
});

describe('idFromPath', () => {
  it('accepts only UUIDs', () => {
    expect(idFromPath(`/dashboard/calls/${U}`, 'calls')).toBe(U);
    expect(idFromPath('/dashboard/calls/abc', 'calls')).toBeNull();
    expect(idFromPath('/dashboard/jobs', 'jobs')).toBeNull();
  });
});

describe('buildDiagnostics', () => {
  it('keeps only the last 5 errors and strips query from route', () => {
    for (let i = 0; i < 8; i++) recordError(`boom ${i}`);
    const d = buildDiagnostics(`/dashboard/jobs/${U}?email=a@b.com#x`);
    expect(d.recent_errors).toHaveLength(5);
    expect(d.recent_errors[0].message).toBe('boom 3');
    expect(d.route).toBe(`/dashboard/jobs/${U}`);
    expect(d.job_id).toBe(U);
    expect(JSON.stringify(d)).not.toContain('a@b.com');
  });
  it('renders readable text', () => {
    expect(diagnosticsToText(buildDiagnostics('/dashboard/calls'))).toContain('Recent errors: none captured');
  });
});
