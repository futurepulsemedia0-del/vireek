// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TYPE_META } from './websiteWidgets';

/**
 * Runs the real public/website-widgets.js in jsdom and checks the pieces that must never drift from the app:
 * the time-zone slot engine (mirrors generateSlots in bookingPolicy.ts) and the default copy (mirrors TYPE_META).
 */
interface Engine {
  _slots: (d: Record<string, unknown>, now: number) => { ms: number; key: string }[];
  _zonedToUtc: (y: number, m: number, d: number, h: number, mi: number, tz?: string) => number | null;
}
let api: Engine;
let source = '';

beforeAll(() => {
  source = readFileSync(resolve(__dirname, '../../public/website-widgets.js'), 'utf8');
  new Function(source)();
  api = (window as unknown as { __vireekWW: { api: Engine } }).__vireekWW.api;
});

const allDays = (open = '09:00', close = '17:00') => Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open, close }]));
const base = (over: Record<string, unknown> = {}) => ({ timezone: 'America/Chicago', hours: allDays(), holidays: [], duration_minutes: 60, lead_time_hours: 0, window_days: 3, buffer_before: 0, buffer_after: 0, busy: [], ...over });
const NOW = Date.UTC(2026, 9, 20, 12, 0); // 07:00 in Chicago (CDT, UTC-5)

describe('slot engine (business time zone)', () => {
  it('generates hourly slots 09:00-16:00 in business time, after "now"', () => {
    const slots = api._slots(base(), NOW);
    expect(slots[0].ms).toBe(Date.UTC(2026, 9, 20, 14, 0)); // 09:00 CDT
    expect(slots.filter((s) => s.key === '2026-10-20')).toHaveLength(8);
  });
  it('respects lead time', () => {
    const slots = api._slots(base({ lead_time_hours: 4 }), NOW); // earliest 11:00 CDT
    expect(slots[0].ms).toBe(Date.UTC(2026, 9, 20, 16, 0));
  });
  it('skips holidays and closed days', () => {
    const slots = api._slots(base({ window_days: 4, holidays: ['2026-10-21'], hours: { ...allDays(), thu: undefined } }), NOW);
    expect(slots.some((s) => s.key === '2026-10-21')).toBe(false);
    expect(slots.some((s) => s.key === '2026-10-22')).toBe(false);
    expect(slots.some((s) => s.key === '2026-10-23')).toBe(true);
  });
  it('removes busy slots and honours buffers', () => {
    const busy = [{ start: new Date(Date.UTC(2026, 9, 20, 16, 0)).toISOString(), minutes: 60 }]; // 11:00-12:00 CDT
    const plain = api._slots(base({ busy }), NOW).filter((s) => s.key === '2026-10-20').map((s) => s.ms);
    expect(plain).not.toContain(Date.UTC(2026, 9, 20, 16, 0));
    expect(plain).toContain(Date.UTC(2026, 9, 20, 15, 0));
    expect(plain).toContain(Date.UTC(2026, 9, 20, 17, 0));
    const buffered = api._slots(base({ busy, buffer_before: 30, buffer_after: 30 }), NOW).filter((s) => s.key === '2026-10-20').map((s) => s.ms);
    expect(buffered).not.toContain(Date.UTC(2026, 9, 20, 15, 0));
    expect(buffered).not.toContain(Date.UTC(2026, 9, 20, 17, 0));
  });
  it('no hours -> no slots; bad timezone falls back instead of throwing', () => {
    expect(api._slots(base({ hours: null }), NOW)).toEqual([]);
    expect(() => api._slots(base({ timezone: 'Not/AZone' }), NOW)).not.toThrow();
  });
  it('handles DST: spring-forward day has no 02:30, offsets switch', () => {
    // US DST began 2026-03-08 (02:00 -> 03:00 Chicago)
    expect(api._zonedToUtc(2026, 3, 8, 2, 30, 'America/Chicago')).toBeNull();
    expect(api._zonedToUtc(2026, 3, 8, 9, 0, 'America/Chicago')).toBe(Date.UTC(2026, 2, 8, 14, 0)); // CDT
    expect(api._zonedToUtc(2026, 3, 7, 9, 0, 'America/Chicago')).toBe(Date.UTC(2026, 2, 7, 15, 0)); // CST
  });
  it('is stable across a different zone (Los Angeles)', () => {
    const slots = api._slots(base({ timezone: 'America/Los_Angeles' }), Date.UTC(2026, 9, 20, 12, 0)); // 05:00 PDT
    expect(slots[0].ms).toBe(Date.UTC(2026, 9, 20, 16, 0)); // 09:00 PDT
  });
});

describe('script hygiene', () => {
  it('default copy matches the dashboard defaults (TYPE_META)', () => {
    for (const [type, m] of Object.entries(TYPE_META)) {
      for (const text of [m.defaultTitle, m.defaultSubtitle, m.defaultButton, m.defaultSuccess].filter(Boolean)) {
        expect(source.includes(JSON.stringify(text).slice(1, -1).replace(/'/g, "\\'")) || source.includes(text), `${type}: "${text}"`).toBe(true);
      }
    }
  });
  it('never writes untrusted data with innerHTML or eval', () => {
    const htmlUses = source.match(/html:\s*[^,}]+/g) ?? [];
    for (const u of htmlUses) expect(u).toMatch(/ICONS\.|svg/);
    expect(source).not.toMatch(/\beval\(|document\.write|new Function/);
  });
  it('a second tag reuses the engine and a tag without data-key renders nothing', () => {
    const before = (window as unknown as { __vireekWW: { api: Engine } }).__vireekWW.api;
    new Function(source)();
    expect((window as unknown as { __vireekWW: { api: Engine } }).__vireekWW.api).toBe(before);
    expect(document.querySelector('[data-vireek-widget-root]')).toBeNull();
  });
});
