import { describe, it, expect } from 'vitest';
import { friendlyCommercialError } from './errors';

describe('friendlyCommercialError', () => {
  it('maps known codes from Error and plain objects', () => {
    expect(friendlyCommercialError(new Error('amount_exceeds_nte'))).toContain('not-to-exceed');
    expect(friendlyCommercialError({ message: 'x self_approval_not_allowed y' })).toContain('cannot approve');
  });
  it('never leaks raw database text for unknown errors', () => {
    expect(friendlyCommercialError(new Error('duplicate key value violates unique constraint "pg_internal"'))).toBe('Something went wrong. Please try again.');
    expect(friendlyCommercialError(null)).toBe('Something went wrong. Please try again.');
  });
});
