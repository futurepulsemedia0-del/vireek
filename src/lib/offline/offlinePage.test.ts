import { describe, expect, it } from 'vitest';
import { OFFLINE_DEFAULT_RETURN, describeLastSync, safeReturnPath } from './offlinePage';

describe('safeReturnPath', () => {
  it('keeps normal in-app paths, including query and hash', () => {
    expect(safeReturnPath('/dashboard/jobs')).toBe('/dashboard/jobs');
    expect(safeReturnPath('/tech/today?tab=2#top')).toBe('/tech/today?tab=2#top');
    expect(safeReturnPath(encodeURIComponent('/dashboard/documents?doc=abc'))).toBe(
      '/dashboard/documents?doc=abc',
    );
  });

  it('falls back when missing or empty', () => {
    expect(safeReturnPath(null)).toBe(OFFLINE_DEFAULT_RETURN);
    expect(safeReturnPath(undefined)).toBe(OFFLINE_DEFAULT_RETURN);
    expect(safeReturnPath('   ')).toBe(OFFLINE_DEFAULT_RETURN);
  });

  it('blocks open-redirect attempts', () => {
    for (const bad of [
      'https://evil.com',
      '//evil.com/path',
      '/\\evil.com',
      'javascript:alert(1)',
      'dashboard',
      '%2F%2Fevil.com',
      '/ok\nHeader: x',
      '%E0%A4%A',
    ]) {
      expect(safeReturnPath(bad)).toBe(OFFLINE_DEFAULT_RETURN);
    }
  });

  it('never loops back to the offline page itself', () => {
    expect(safeReturnPath('/offline')).toBe(OFFLINE_DEFAULT_RETURN);
    expect(safeReturnPath('/offline/')).toBe(OFFLINE_DEFAULT_RETURN);
    expect(safeReturnPath('/offline?from=/x')).toBe(OFFLINE_DEFAULT_RETURN);
    expect(safeReturnPath('/offline.html')).toBe(OFFLINE_DEFAULT_RETURN);
    expect(safeReturnPath('/offline-tips')).toBe('/offline-tips');
  });

  it('honours a custom fallback and rejects absurdly long input', () => {
    expect(safeReturnPath('https://x.y', '/home')).toBe('/home');
    expect(safeReturnPath(`/${'a'.repeat(3000)}`)).toBe(OFFLINE_DEFAULT_RETURN);
  });
});

describe('describeLastSync', () => {
  const now = 1_700_000_000_000;
  it('describes ages in plain language', () => {
    expect(describeLastSync(null, now)).toMatch(/not synced yet/i);
    expect(describeLastSync(now - 10_000, now)).toBe('Last synced just now');
    expect(describeLastSync(now - 5 * 60_000, now)).toBe('Last synced 5 min ago');
    expect(describeLastSync(now - 3 * 3_600_000, now)).toBe('Last synced 3 h ago');
    expect(describeLastSync(now - 2 * 86_400_000, now)).toBe('Last synced 2 d ago');
  });
  it('never shows a negative age for clock skew', () => {
    expect(describeLastSync(now + 60_000, now)).toBe('Last synced just now');
  });
});
