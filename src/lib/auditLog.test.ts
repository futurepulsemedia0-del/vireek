import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/csvExport', () => ({ exportToCsv: vi.fn() }));

import {
  REDACTED,
  buildAuditDetails,
  csvSafe,
  dayRangeToIso,
  describeTarget,
  escapeLike,
  formatAction,
  hasActiveFilters,
  redact,
  EMPTY_FILTERS,
} from '@/lib/auditLog';

describe('buildAuditDetails', () => {
  it('returns null for missing or empty metadata', () => {
    expect(buildAuditDetails(null)).toBeNull();
    expect(buildAuditDetails({})).toBeNull();
  });

  it('renders the { changes } shape as diff rows', () => {
    const d = buildAuditDetails({ changes: { plan: { from: 'starter', to: 'pro' } } });
    expect(d).toEqual({ kind: 'diff', rows: [{ field: 'plan', from: 'starter', to: 'pro' }] });
  });

  it('diffs { before, after } and keeps changed fields only', () => {
    const d = buildAuditDetails({ before: { a: 1, b: 2 }, after: { a: 1, b: 3, c: 'new' } });
    expect(d).toEqual({
      kind: 'diff',
      rows: [
        { field: 'b', from: '2', to: '3' },
        { field: 'c', from: '—', to: 'new' },
      ],
    });
  });

  it('falls back to pretty JSON for unknown shapes', () => {
    const d = buildAuditDetails({ format: 'csv' });
    expect(d?.kind).toBe('json');
  });

  it('redacts secret-looking keys in every shape', () => {
    const diff = buildAuditDetails({ changes: { api_key: { from: 'abc', to: 'xyz' } } });
    expect(diff).toMatchObject({ kind: 'diff', rows: [{ field: 'api_key', from: REDACTED, to: REDACTED }] });
    const raw = buildAuditDetails({ note: 'x', nested: { password: 'hunter2' } });
    expect(raw?.kind === 'json' && raw.json.includes('hunter2')).toBe(false);
  });
});

describe('redact', () => {
  it('is depth-limited and does not mutate input', () => {
    const input = { token: 't', ok: 1 };
    expect(redact(input)).toEqual({ token: REDACTED, ok: 1 });
    expect(input.token).toBe('t');
  });
});

describe('helpers', () => {
  it('escapeLike neutralises wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('formatAction humanises identifiers', () => {
    expect(formatAction('custom_role_updated')).toBe('Custom role updated');
    expect(formatAction('team.member-removed')).toBe('Team member removed');
  });

  it('csvSafe prefixes formula starters only', () => {
    expect(csvSafe('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvSafe('@x')).toBe("'@x");
    expect(csvSafe('plain')).toBe('plain');
    expect(csvSafe(null)).toBe('');
  });

  it('describeTarget handles partial targets', () => {
    expect(describeTarget({ target_table: 'jobs', target_id: '1' })).toBe('jobs · 1');
    expect(describeTarget({ target_table: null, target_id: null })).toBe('—');
  });

  it('dayRangeToIso is inclusive of the end day and swaps reversed ranges', () => {
    const r = dayRangeToIso('2026-10-01', '2026-10-03');
    expect(r.gte).toBe(new Date('2026-10-01T00:00:00').toISOString());
    expect(r.lt).toBe(new Date('2026-10-04T00:00:00').toISOString());
    expect(dayRangeToIso('2026-10-03', '2026-10-01')).toEqual(r);
    expect(dayRangeToIso('', 'garbage')).toEqual({});
  });

  it('hasActiveFilters ignores whitespace-only actor', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, actor: '  ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, action: 'x' })).toBe(true);
  });
});
