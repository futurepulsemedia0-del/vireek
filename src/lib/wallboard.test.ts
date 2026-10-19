import { describe, expect, it } from 'vitest';
import {
  MAX_ROTATION_SECONDS,
  MIN_ROTATION_SECONDS,
  PANEL_KEYS,
  STALE_AFTER_MS,
  activePanels,
  buildWallboardUrl,
  clampRotation,
  dwellMs,
  formatAge,
  formatClock,
  formatMoney,
  formatMoneyCompact,
  formatSla,
  groupJobs,
  hasCriticalEmergency,
  isStale,
  isValidWallboardToken,
  normalizePanels,
  num,
  parseSnapshot,
  projectPoints,
  revenuePace,
  stepIndex,
  type WallJob,
  type WallRevenue,
  type WallboardSnapshot,
} from './wallboard';

const TOKEN = 'a'.repeat(64);
const NOW = Date.parse('2026-10-19T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const raw = (over: Record<string, unknown> = {}) => ({
  generated_at: '2026-10-19T12:00:00Z',
  timezone: 'America/Chicago',
  config: { name: 'Front office', rotation_seconds: 20, panels: ['revenue', 'jobs'], channel_key: 'k'.repeat(32) },
  job_counts: { scheduled: 3, en_route: 1, in_progress: 2, completed: 5, cancelled: 1, late: 1, total: 12 },
  jobs: [{ id: 'j1', customer: 'Maria G.', service: 'AC repair', scheduled_datetime: '2026-10-19T14:00:00Z', status: 'scheduled', technician: 'Sam', late: true }],
  technicians: [{ id: 't1', name: 'Sam', status: 'on_site', job_customer: 'Maria G.', job_service: 'AC repair', lat: '41.878', lng: -87.63, place: 'Chicago, IL', speed_mph: '0', last_fix_at: '2026-10-19T11:58:00Z', completed_today: 2 }],
  emergencies: [],
  calls: { total_today: 20, missed_today: 4, emergency_today: 1, recent_missed: [{ id: 'c1', caller: '•••• 1234', at: '2026-10-19T11:00:00Z' }] },
  revenue: { today: '1200.50', mtd: 15000, goal: 30000, day_of_month: 15, days_in_month: 30, daily: [{ day: '2026-10-19', amount: 1200.5 }] },
  ...over,
});

const snap = (over: Partial<WallboardSnapshot> = {}): WallboardSnapshot => ({ ...(parseSnapshot(raw()) as WallboardSnapshot), ...over });

describe('token validation', () => {
  it('accepts exactly 64 lowercase hex chars', () => {
    expect(isValidWallboardToken(TOKEN)).toBe(true);
    expect(isValidWallboardToken('0123456789abcdef'.repeat(4))).toBe(true);
  });
  it('rejects wrong length, uppercase, non-hex and empty values', () => {
    expect(isValidWallboardToken('a'.repeat(63))).toBe(false);
    expect(isValidWallboardToken('a'.repeat(65))).toBe(false);
    expect(isValidWallboardToken('A'.repeat(64))).toBe(false);
    expect(isValidWallboardToken('g'.repeat(64))).toBe(false);
    expect(isValidWallboardToken('')).toBe(false);
    expect(isValidWallboardToken(undefined)).toBe(false);
    expect(isValidWallboardToken(null)).toBe(false);
  });
});

describe('parseSnapshot', () => {
  it('maps a full payload and coerces numeric strings', () => {
    const s = parseSnapshot(raw()) as WallboardSnapshot;
    expect(s.config.name).toBe('Front office');
    expect(s.config.rotationSeconds).toBe(20);
    expect(s.jobCounts.inProgress).toBe(2);
    expect(s.technicians[0].lat).toBeCloseTo(41.878, 3);
    expect(s.technicians[0].speedMph).toBe(0);
    expect(s.revenue.today).toBeCloseTo(1200.5, 2);
    expect(s.jobs[0].late).toBe(true);
    expect(s.calls.recentMissed).toHaveLength(1);
  });
  it('returns null when the payload is not a snapshot', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('x')).toBeNull();
    expect(parseSnapshot([])).toBeNull();
    expect(parseSnapshot({})).toBeNull();
    expect(parseSnapshot({ config: 'nope' })).toBeNull();
  });
  it('degrades missing sections to empty values instead of throwing', () => {
    const s = parseSnapshot({ config: {} }) as WallboardSnapshot;
    expect(s.jobs).toEqual([]);
    expect(s.technicians).toEqual([]);
    expect(s.emergencies).toEqual([]);
    expect(s.calls.missedToday).toBe(0);
    expect(s.revenue.goal).toBeNull();
    expect(s.config.panels).toEqual([...PANEL_KEYS]);
    expect(s.config.rotationSeconds).toBe(15);
  });
  it('falls back on unknown statuses and drops non-object rows', () => {
    const s = parseSnapshot(
      raw({
        jobs: [{ id: 'a', status: 'weird' }, 'junk', null],
        technicians: [{ id: 't', status: 'sleeping' }],
        emergencies: [{ id: 'e', severity: 'apocalyptic' }],
      }),
    ) as WallboardSnapshot;
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0].status).toBe('scheduled');
    expect(s.technicians[0].status).toBe('offline');
    expect(s.emergencies[0].severity).toBe('standard');
  });
  it('treats a null goal as "no goal" and never as zero', () => {
    expect((parseSnapshot(raw({ revenue: { today: 0, mtd: 0, goal: null } })) as WallboardSnapshot).revenue.goal).toBeNull();
  });
});

describe('num', () => {
  it('handles numbers, numeric strings and garbage', () => {
    expect(num(5)).toBe(5);
    expect(num('12.5')).toBe(12.5);
    expect(num('')).toBe(0);
    expect(num('abc', 7)).toBe(7);
    expect(num(NaN, 3)).toBe(3);
    expect(num(Infinity, 3)).toBe(3);
    expect(num(null)).toBe(0);
  });
});

describe('config normalisation', () => {
  it('clamps rotation to the allowed range', () => {
    expect(clampRotation(1)).toBe(MIN_ROTATION_SECONDS);
    expect(clampRotation(9999)).toBe(MAX_ROTATION_SECONDS);
    expect(clampRotation('30')).toBe(30);
    expect(clampRotation(undefined)).toBe(15);
    expect(clampRotation(12.6)).toBe(13);
  });
  it('keeps canonical panel order, drops unknown and duplicates, falls back to all', () => {
    expect(normalizePanels(['revenue', 'jobs', 'jobs', 'bogus'])).toEqual(['jobs', 'revenue']);
    expect(normalizePanels([])).toEqual([...PANEL_KEYS]);
    expect(normalizePanels('jobs')).toEqual([...PANEL_KEYS]);
    expect(normalizePanels(['bogus'])).toEqual([...PANEL_KEYS]);
  });
});

describe('rotation', () => {
  it('wraps in both directions and survives empty / invalid input', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(5, 3, 1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(stepIndex(Number.NaN, 3, 1)).toBe(1);
  });
  it('skips an empty emergencies panel but keeps it when it is the only one', () => {
    const all = snap({ config: { ...snap().config, panels: [...PANEL_KEYS] } });
    expect(activePanels(all)).not.toContain('emergencies');
    expect(activePanels(all)).toHaveLength(4);
    const only = snap({ config: { ...snap().config, panels: ['emergencies'] } });
    expect(activePanels(only)).toEqual(['emergencies']);
  });
  it('includes emergencies when one is open', () => {
    const s = snap({
      config: { ...snap().config, panels: [...PANEL_KEYS] },
      emergencies: [{ id: 'e', severity: 'high', status: 'dispatching', trade: 'hvac', customer: 'A B.', technician: null, slaDueAt: null, createdAt: null, slaBreached: false }],
    });
    expect(activePanels(s)).toContain('emergencies');
  });
  it('returns every panel before the first snapshot arrives', () => {
    expect(activePanels(null)).toEqual([...PANEL_KEYS]);
  });
  it('holds a critical or SLA-breached emergency 1.5x longer', () => {
    const base = { id: 'e', status: 'x', trade: 'hvac', customer: 'A B.', technician: null, slaDueAt: null, createdAt: null };
    const crit = snap({ emergencies: [{ ...base, severity: 'critical', slaBreached: false }] });
    const breached = snap({ emergencies: [{ ...base, severity: 'standard', slaBreached: true }] });
    const calm = snap({ emergencies: [{ ...base, severity: 'standard', slaBreached: false }] });
    expect(hasCriticalEmergency(crit)).toBe(true);
    expect(hasCriticalEmergency(calm)).toBe(false);
    expect(dwellMs('emergencies', crit, 20)).toBe(30_000);
    expect(dwellMs('emergencies', breached, 20)).toBe(30_000);
    expect(dwellMs('emergencies', calm, 20)).toBe(20_000);
    expect(dwellMs('jobs', crit, 20)).toBe(20_000);
    expect(dwellMs('jobs', null, 1)).toBe(MIN_ROTATION_SECONDS * 1000);
  });
});

describe('revenuePace', () => {
  const rev = (over: Partial<WallRevenue> = {}): WallRevenue => ({ today: 0, mtd: 0, goal: 30000, dayOfMonth: 15, daysInMonth: 30, daily: [], ...over });
  it('reports no_goal for null, zero or negative goals', () => {
    expect(revenuePace(rev({ goal: null })).status).toBe('no_goal');
    expect(revenuePace(rev({ goal: 0 })).status).toBe('no_goal');
    expect(revenuePace(rev({ goal: -5 })).status).toBe('no_goal');
  });
  it('compares month-to-date against the pro-rated target', () => {
    const p = revenuePace(rev({ mtd: 15000 }));
    expect(p.dailyTarget).toBe(1000);
    expect(p.expectedToDate).toBe(15000);
    expect(p.status).toBe('on_track');
    expect(p.pctOfGoal).toBe(50);
    expect(revenuePace(rev({ mtd: 16000 })).status).toBe('ahead');
    expect(revenuePace(rev({ mtd: 14300 })).status).toBe('on_track');
    expect(revenuePace(rev({ mtd: 10000 })).status).toBe('behind');
    expect(revenuePace(rev({ mtd: 10000 })).paceDelta).toBe(-5000);
  });
  it("computes today's share of the daily target", () => {
    expect(revenuePace(rev({ today: 500 })).todayPct).toBe(50);
    expect(revenuePace(rev({ today: 2500 })).todayPct).toBe(250);
  });
  it('can exceed 100% and never goes negative', () => {
    expect(revenuePace(rev({ mtd: 45000 })).pctOfGoal).toBe(150);
    expect(revenuePace(rev({ mtd: -10 })).pctOfGoal).toBe(0);
  });
  it('does not blow up on the last day or with a bad day count', () => {
    expect(revenuePace(rev({ dayOfMonth: 31, daysInMonth: 30, mtd: 30000 })).expectedToDate).toBe(30000);
    expect(Number.isFinite(revenuePace(rev({ daysInMonth: 1, dayOfMonth: 1 })).dailyTarget)).toBe(true);
  });
});

describe('formatting', () => {
  it('formats money', () => {
    expect(formatMoney(1234.56)).toBe('$1,235');
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(-50)).toBe('-$50');
    expect(formatMoney(Number.NaN)).toBe('$0');
  });
  it('formats compact money', () => {
    expect(formatMoneyCompact(950)).toBe('$950');
    expect(formatMoneyCompact(12_400)).toBe('$12K');
    expect(formatMoneyCompact(1_250_000)).toBe('$1.3M');
    expect(formatMoneyCompact(25_000_000)).toBe('$25M');
  });
  it('formats ages', () => {
    expect(formatAge(null, NOW)).toBe('no signal');
    expect(formatAge('garbage', NOW)).toBe('no signal');
    expect(formatAge(ago(10_000), NOW)).toBe('just now');
    expect(formatAge(ago(5 * 60_000), NOW)).toBe('5 min ago');
    expect(formatAge(ago(3 * 3_600_000), NOW)).toBe('3 h ago');
    expect(formatAge(ago(50 * 3_600_000), NOW)).toBe('2 d ago');
    expect(formatAge(new Date(NOW + 60_000).toISOString(), NOW)).toBe('just now');
  });
  it('formats SLA countdowns', () => {
    expect(formatSla(null, NOW)).toEqual({ text: 'No SLA', overdue: false });
    expect(formatSla(new Date(NOW + 12 * 60_000).toISOString(), NOW)).toEqual({ text: '12 min left', overdue: false });
    expect(formatSla(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toEqual({ text: '5 min overdue', overdue: true });
    expect(formatSla(new Date(NOW + 95 * 60_000).toISOString(), NOW)).toEqual({ text: '1 h 35 min left', overdue: false });
  });
  it('renders the clock in the business timezone and tolerates a bad one', () => {
    expect(formatClock(NOW, 'America/Chicago').time).toBe('7:00 AM');
    expect(formatClock(NOW, 'UTC').time).toBe('12:00 PM');
    expect(formatClock(NOW, 'Not/AZone').time).toBe('12:00 PM');
  });
  it('builds the TV URL without double slashes', () => {
    expect(buildWallboardUrl('https://vireek.com/', TOKEN)).toBe(`https://vireek.com/wallboard/${TOKEN}`);
  });
});

describe('staleness', () => {
  it('is stale before the first success and after the threshold', () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(NOW - 1000, NOW)).toBe(false);
    expect(isStale(NOW - STALE_AFTER_MS, NOW)).toBe(false);
    expect(isStale(NOW - STALE_AFTER_MS - 1, NOW)).toBe(true);
  });
});

describe('groupJobs', () => {
  const job = (id: string, status: WallJob['status']): WallJob => ({ id, customer: 'X Y.', service: null, scheduledAt: null, status, technician: null, late: false });
  it('buckets by status, caps each column and reports hidden rows', () => {
    const g = groupJobs([job('1', 'scheduled'), job('2', 'scheduled'), job('3', 'scheduled'), job('4', 'completed'), job('5', 'cancelled')], 2);
    expect(g.scheduled.items).toHaveLength(2);
    expect(g.scheduled.hidden).toBe(1);
    expect(g.completed.items).toHaveLength(1);
    expect(g.in_progress.items).toHaveLength(0);
    expect(g.cancelled).toBeUndefined();
  });
  it('never returns negative hidden counts', () => {
    expect(groupJobs([], 5).scheduled.hidden).toBe(0);
    expect(groupJobs([job('1', 'scheduled')], 0).scheduled.hidden).toBe(1);
  });
});

describe('projectPoints', () => {
  it('returns nothing for no valid points and ignores invalid coordinates', () => {
    expect(projectPoints([], 400, 300)).toEqual([]);
    expect(projectPoints([{ id: 'a', lat: Number.NaN, lng: 0 }, { id: 'b', lat: 95, lng: 0 }], 400, 300)).toEqual([]);
  });
  it('centres a single point and identical points', () => {
    expect(projectPoints([{ id: 'a', lat: 41, lng: -87 }], 400, 300)).toEqual([{ id: 'a', x: 200, y: 150 }]);
    const two = projectPoints([{ id: 'a', lat: 41, lng: -87 }, { id: 'b', lat: 41, lng: -87 }], 400, 300);
    expect(two.every((p) => p.x === 200 && p.y === 150)).toBe(true);
  });
  it('keeps north up and east right, inside the padded box', () => {
    const [sw, ne] = projectPoints([{ id: 'sw', lat: 41.0, lng: -88.0 }, { id: 'ne', lat: 42.0, lng: -87.0 }], 400, 300, 24);
    expect(ne.y).toBeLessThan(sw.y);
    expect(ne.x).toBeGreaterThan(sw.x);
    for (const p of [sw, ne]) {
      expect(p.x).toBeGreaterThan(23.999);
      expect(p.x).toBeLessThan(376.001);
      expect(p.y).toBeGreaterThan(23.999);
      expect(p.y).toBeLessThan(276.001);
    }
  });
  it('handles points on a single horizontal or vertical line', () => {
    const h = projectPoints([{ id: 'a', lat: 41, lng: -88 }, { id: 'b', lat: 41, lng: -87 }], 400, 300);
    expect(h[0].y).toBe(150);
    expect(h[1].y).toBe(150);
    expect(h[1].x).toBeGreaterThan(h[0].x);
    const v = projectPoints([{ id: 'a', lat: 41, lng: -87 }, { id: 'b', lat: 42, lng: -87 }], 400, 300);
    expect(v[0].x).toBe(200);
    expect(v[1].y).toBeLessThan(v[0].y);
  });
});
