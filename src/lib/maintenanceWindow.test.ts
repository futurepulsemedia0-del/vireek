import { describe, it, expect } from 'vitest';
import {
  buildIcs,
  formatDuration,
  getCountdown,
  getPhase,
  parseTime,
  safeStatusUrl,
  type MaintenanceWindow,
} from './maintenanceWindow';

const T0 = Date.parse('2026-10-20T22:00:00Z');
const T1 = Date.parse('2026-10-21T00:00:00Z');

describe('maintenanceWindow', () => {
  it('parses valid ISO and rejects junk', () => {
    expect(parseTime('2026-10-20T22:00:00Z')).toBe(T0);
    expect(parseTime('nope')).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(parseTime(undefined)).toBeNull();
  });

  it('computes phases', () => {
    const w = { startsAt: T0, endsAt: T1 };
    expect(getPhase({ startsAt: null, endsAt: null }, T0)).toBe('none');
    expect(getPhase(w, T0 - 1)).toBe('upcoming');
    expect(getPhase(w, T0)).toBe('in_progress');
    expect(getPhase(w, T1)).toBe('completed');
    expect(getPhase(w, T0 - 1, true)).toBe('in_progress');
  });

  it('handles start-only and end-only windows', () => {
    expect(getPhase({ startsAt: T0, endsAt: null }, T1)).toBe('in_progress');
    expect(getPhase({ startsAt: null, endsAt: T1 }, T0)).toBe('upcoming');
    expect(getPhase({ startsAt: null, endsAt: T1 }, T1)).toBe('completed');
  });

  it('builds countdown parts and never goes negative', () => {
    const c = getCountdown(T0, T0 - (86400 + 3600 * 2 + 60 * 3 + 4) * 1000);
    expect(c).toMatchObject({ days: 1, hours: 2, minutes: 3, seconds: 4 });
    expect(getCountdown(T0, T0 + 5000).totalMs).toBe(0);
  });

  it('formats durations', () => {
    expect(formatDuration(30_000)).toBeNull();
    expect(formatDuration(2.5 * 3600_000)).toBe('2 h 30 min');
    expect(formatDuration(26 * 3600_000)).toBe('1 d 2 h');
  });

  it('only allows safe status URLs', () => {
    expect(safeStatusUrl('/status')).toBe('/status');
    expect(safeStatusUrl('https://status.vireek.com')).toBe('https://status.vireek.com');
    expect(safeStatusUrl('javascript:alert(1)')).toBe('/status');
    expect(safeStatusUrl('//evil.com')).toBe('/status');
  });

  it('builds an ics only when both bounds exist', () => {
    const win: MaintenanceWindow = {
      title: 'Update, planned',
      message: 'Line1\nLine2',
      startsAt: T0,
      endsAt: T1,
      statusUrl: '/status',
    };
    const ics = buildIcs(win, 'https://vireek.com');
    expect(ics).toContain('DTSTART:20261020T220000Z');
    expect(ics).toContain('DTEND:20261021T000000Z');
    expect(ics).toContain('SUMMARY:Vireek: Update\\, planned');
    expect(buildIcs({ ...win, endsAt: null }, 'https://vireek.com')).toBeNull();
  });
});
