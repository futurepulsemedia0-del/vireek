import { describe, it, expect, vi } from 'vitest';

// Pure helpers only — keep the real Supabase client out of the test.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/customFieldsApi', () => ({ useAccountOwnerId: () => undefined }));

import { friendlyReportError } from './pesticideReportsApi';

describe('friendlyReportError', () => {
  it('shows the message after the code for period / reference problems', () => {
    expect(friendlyReportError(new Error('invalid_period: choose a start date before the end date'))).toBe('choose a start date before the end date');
    expect(friendlyReportError({ message: 'invalid_reference: enter the confirmation or filing number' })).toBe('enter the confirmation or filing number');
    expect(friendlyReportError(new Error('invalid_period: too many applications in this period to seal in one report; choose a shorter period'))).toContain('shorter period');
  });
  it('maps sealing / filing rules', () => {
    expect(friendlyReportError(new Error('Report not found or already marked as filed'))).toBe('That report was not found or is already marked as filed.');
    expect(friendlyReportError(new Error('pesticide usage reports are sealed and cannot be edited'))).toBe('Sealed reports cannot be changed.');
  });
  it('falls back to the shared trade-pack mapper', () => {
    expect(friendlyReportError(new Error('not_permitted'))).toBe('You do not have permission to manage trade packs.');
    expect(friendlyReportError(new Error('pack_not_installed'))).toBe('This pack is not installed yet.');
    expect(friendlyReportError(new Error('boom'), 'Nope')).toBe('Nope');
    expect(friendlyReportError(null, 'Nope')).toBe('Nope');
  });
});
