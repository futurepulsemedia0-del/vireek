import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
import { compareVersions, evaluatePolicy, type ReleasePolicy } from './appUpdate';

const policy = (min: string, latest: string): ReleasePolicy => ({ min_version: min, latest_version: latest, store_url: 'https://example.com', message: null });

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0-beta', '2.0.1')).toBe(-1);
  });
});

describe('evaluatePolicy', () => {
  it('does nothing without a policy', () => {
    expect(evaluatePolicy('1.0.0', null, null).kind).toBe('none');
  });

  it('forces an update below the minimum version', () => {
    expect(evaluatePolicy('1.0.0', policy('1.2.0', '1.3.0'), null).kind).toBe('force');
  });

  it('offers a dismissible update below the latest version', () => {
    expect(evaluatePolicy('1.2.0', policy('1.0.0', '1.3.0'), null).kind).toBe('soft');
    expect(evaluatePolicy('1.2.0', policy('1.0.0', '1.3.0'), '1.3.0').kind).toBe('none');
  });

  it('is quiet when up to date', () => {
    expect(evaluatePolicy('1.3.0', policy('1.0.0', '1.3.0'), null).kind).toBe('none');
  });
});
