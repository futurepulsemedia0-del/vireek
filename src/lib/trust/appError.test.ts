import { describe, expect, it } from 'vitest';
import { classifyError, classifyKind, ConflictError, isAppError, toAppError } from './appError';
import { INCIDENT_ID_RE } from '@/lib/incident';

describe('classifyKind', () => {
  it.each([
    [{ status: 401 }, 'auth'],
    [{ status: 403 }, 'permission'],
    [{ status: 409 }, 'conflict'],
    [{ status: 429 }, 'rate_limit'],
    [{ status: 422 }, 'validation'],
    [{ status: 503 }, 'server'],
    [{ code: '42501', message: 'permission denied for table jobs' }, 'permission'],
    [{ code: '23505', message: 'duplicate key value' }, 'conflict'],
    [{ code: '23514', message: 'check constraint' }, 'validation'],
    [{ code: 'PGRST301', message: 'JWT expired' }, 'auth'],
    [{ code: '40001' }, 'conflict'],
    [{ code: '08006' }, 'network'],
    [new TypeError('Failed to fetch'), 'network'],
    [{ name: 'AbortError' }, 'network'],
    [{ name: 'AuthSessionMissingError', message: 'x' }, 'auth'],
    [{ message: 'new row violates row-level security policy' }, 'permission'],
    ['Too many requests', 'rate_limit'],
    [{ message: 'something weird' }, 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ])('%j -> %s', (input, kind) => {
    expect(classifyKind(input, { offline: false })).toBe(kind);
  });

  it('offline always wins', () => expect(classifyKind({ status: 500 }, { offline: true })).toBe('network'));
  it('ConflictError is conflict', () => expect(classifyKind(new ConflictError(null))).toBe('conflict'));
  it('status beats message heuristics', () => expect(classifyKind({ status: 403, message: 'Failed to fetch' }, { offline: false })).toBe('permission'));
});

describe('classifyError', () => {
  it('always has a well-formed reference id and never leaks the raw message', () => {
    const e = classifyError({ code: '42501', message: 'permission denied for table secret_table' }, { offline: false });
    expect(e.referenceId).toMatch(INCIDENT_ID_RE);
    expect(JSON.stringify(e)).not.toContain('secret_table');
    expect(e.messageKey).toBe('trust.error.permission');
    expect(e.recovery).toBe('contact_support');
  });
  it('maps recoveries per kind', () => {
    const rec = (i: unknown) => classifyError(i, { offline: false }).recovery;
    expect(rec({ status: 401 })).toBe('sign_in');
    expect(rec({ status: 500 })).toBe('retry');
    expect(rec({ status: 409 })).toBe('refresh');
    expect(rec({ status: 429 })).toBe('wait');
    expect(rec({ status: 422 })).toBe('fix_field');
    expect(rec({})).toBe('contact_support');
  });
  it('retryable only for transient kinds', () => {
    const r = (i: unknown) => classifyError(i, { offline: false }).retryable;
    expect([r({ status: 500 }), r(new TypeError('Failed to fetch')), r({ status: 429 })]).toEqual([true, true, true]);
    expect([r({ status: 401 }), r({ status: 403 }), r({ status: 422 }), r({})]).toEqual([false, false, false, false]);
  });
  it('keeps only string field errors for validation', () => {
    const e = classifyError({ status: 422, fieldErrors: { email: 'bad', n: 3, '': 'x' } }, { offline: false });
    expect(e.fieldErrors).toEqual({ email: 'bad' });
    expect(classifyError({ status: 500, fieldErrors: { a: 'b' } }, { offline: false }).fieldErrors).toBeUndefined();
  });
  it('rate limit exposes a bounded retry delay', () => {
    expect(classifyError({ status: 429, retryAfter: 7 }, { offline: false }).retryAfterMs).toBe(7000);
    expect(classifyError({ status: 429, retryAfter: 99999 }, { offline: false }).retryAfterMs).toBe(300000);
    expect(classifyError({ status: 429 }, { offline: false }).retryAfterMs).toBe(5000);
  });
  it('reuses a supplied reference id and toAppError is idempotent', () => {
    const e = classifyError({}, { referenceId: 'INC-AAAA-BBBB', offline: false });
    expect(e.referenceId).toBe('INC-AAAA-BBBB');
    expect(isAppError(e)).toBe(true);
    expect(toAppError(e)).toBe(e);
  });
});
