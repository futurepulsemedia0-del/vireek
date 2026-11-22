import { describe, expect, it } from 'vitest';
import appSrc from '@/App.tsx?raw';
import pageSrc from './StaffAbusePage.tsx?raw';
import abuseEn from '@/locales/en/abuse.json';

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('Staff abuse console wiring', () => {
  it('registers /staff/abuse exactly once and only behind StaffRoute', () => {
    expect(count(appSrc, 'path="/staff/abuse"')).toBe(1);
    const i = appSrc.indexOf('path="/staff/abuse"');
    const line = appSrc.slice(i, appSrc.indexOf('\n', i));
    expect(line).toContain('<StaffRoute>');
    expect(line).toContain('<StaffAbusePage />');
    expect(appSrc).toContain("import('@/pages/admin/StaffAbusePage')");
  });

  it('the page declares the same path it is mounted on', () => {
    expect(pageSrc).toContain('https://vireek.com/staff/abuse');
  });

  it('its i18n bundle exists and is not empty', () => {
    expect(Object.keys(abuseEn as Record<string, unknown>).length).toBeGreaterThan(0);
  });
});
