import { describe, expect, it } from 'vitest';
import {
  addDays,
  advanceSegment,
  buildAgenda,
  buildQuarterReview,
  buildScorecard,
  buildSeatTree,
  cadenceRole,
  chartGaps,
  estimateMissImpactCents,
  formatClock,
  formatMetric,
  impactToCents,
  metricStatus,
  mondayOf,
  parseAmountLabel,
  pastWeeks,
  quarterEnd,
  quarterLabel,
  quarterStart,
  rankIssues,
  reviewMetric,
  segmentRemainingMs,
  sortPriorities,
  tabsFor,
  targetToStored,
  todayIn,
  trendSeries,
  validateAction,
  validateIssue,
  validatePriority,
  validateTarget,
  wouldCreateCycle,
  type Issue,
  type MetricValue,
  type Priority,
  type Seat,
  type Target,
} from '@/lib/cadence';

const hi = (k: Target['metric_key'], v: number): Target => ({ metric_key: k, target_value: v, direction: 'higher' });
const lo = (k: Target['metric_key'], v: number): Target => ({ metric_key: k, target_value: v, direction: 'lower' });
const mv = (k: MetricValue['metric_key'], value: number | null, hidden = false): MetricValue => ({ metric_key: k, value, detail: {}, hidden });

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1', title: 'Issue', description: null, status: 'open', source_type: 'manual', source_ref: null,
    metric_key: null, impact_cents: null, needs_decision: false, owner_user_id: null, owner_name: null,
    resolution: null, solved_at: null, created_at: '2026-10-01T10:00:00Z', ...over,
  };
}
function prio(over: Partial<Priority> = {}): Priority {
  return {
    id: 'p1', title: 'Priority', description: null, owner_user_id: null, owner_name: null,
    due_date: '2026-12-31', status: 'on_track', progress_pct: 0, goal_id: null, completed_at: null, ...over,
  };
}
function seat(over: Partial<Seat> = {}): Seat {
  return { id: 's1', parent_id: null, title: 'Seat', holder_user_id: null, holder_name: null, responsibilities: [], metric_keys: [], sort_order: 0, ...over };
}

describe('week math', () => {
  it('finds the Monday of any day', () => {
    expect(mondayOf('2026-10-24')).toBe('2026-10-19'); // Saturday
    expect(mondayOf('2026-10-19')).toBe('2026-10-19'); // Monday
    expect(mondayOf('2026-10-25')).toBe('2026-10-19'); // Sunday
  });
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('lists completed weeks oldest first', () => {
    expect(pastWeeks('2026-10-19', 3)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
  });
  it('uses the time zone for "today"', () => {
    const t = new Date('2026-10-24T23:30:00Z');
    expect(todayIn('UTC', t)).toBe('2026-10-24');
    expect(todayIn('Asia/Tehran', t)).toBe('2026-10-25');
    expect(todayIn('Not/AZone', t)).toBe('2026-10-24');
  });
  it('computes quarters', () => {
    expect(quarterStart('2026-11-15')).toBe('2026-10-01');
    expect(quarterEnd('2026-11-15')).toBe('2026-12-31');
    expect(quarterEnd('2026-02-10')).toBe('2026-03-31');
    expect(quarterLabel('2026-05-01')).toBe('Q2 2026');
  });
});

describe('target status', () => {
  it('is green when higher-is-better meets target', () => {
    expect(metricStatus(90, hi('booked_rate', 90))).toBe('green');
    expect(metricStatus(89.9, hi('booked_rate', 90))).toBe('red');
  });
  it('flips for lower-is-better', () => {
    expect(metricStatus(35, lo('dso', 40))).toBe('green');
    expect(metricStatus(41, lo('dso', 40))).toBe('red');
  });
  it('is neutral without data or target', () => {
    expect(metricStatus(null, hi('csat', 4))).toBe('none');
    expect(metricStatus(5, null)).toBe('none');
    expect(metricStatus(NaN, hi('csat', 4))).toBe('none');
  });
  it('treats a zero value as real data', () => {
    expect(metricStatus(0, hi('calls_answered', 10))).toBe('red');
  });
});

describe('formatting + targets', () => {
  it('formats each unit', () => {
    expect(formatMetric('revenue', 1234500)).toBe('$12,345');
    expect(formatMetric('booked_rate', 82.5)).toBe('82.5%');
    expect(formatMetric('booked_rate', 80)).toBe('80%');
    expect(formatMetric('dso', 38.4)).toBe('38 d');
    expect(formatMetric('csat', 4.5)).toBe('4.50');
    expect(formatMetric('calls_answered', 1200)).toBe('1,200');
    expect(formatMetric('margin', null)).toBe('—');
  });
  it('stores revenue targets in cents', () => {
    expect(targetToStored('revenue', 12000.5)).toBe(1200050);
    expect(targetToStored('margin', 35)).toBe(35);
  });
  it('validates target input', () => {
    expect(validateTarget('margin', '')).not.toBeNull();
    expect(validateTarget('margin', 'abc')).not.toBeNull();
    expect(validateTarget('margin', '120')).not.toBeNull();
    expect(validateTarget('csat', '6')).not.toBeNull();
    expect(validateTarget('csat', '4.5')).toBeNull();
    expect(validateTarget('dso', '-1')).not.toBeNull();
    expect(validateTarget('revenue', '25000')).toBeNull();
  });
});

describe('scorecard', () => {
  it('builds rows with status, delta and red streak', () => {
    const rows = buildScorecard({
      current: [mv('booked_rate', 70), mv('dso', 30), mv('csat', null)],
      previous: { booked_rate: 75, dso: 28 },
      targets: [hi('booked_rate', 80), lo('dso', 40)],
      history: { booked_rate: [85, 70, 72] },
    });
    const br = rows.find((r) => r.def.key === 'booked_rate')!;
    expect(br.status).toBe('red');
    expect(br.delta).toBe(-5);
    expect(br.redStreak).toBe(3); // this week + 2 prior reds (72, 70) before the 85
    expect(rows.find((r) => r.def.key === 'dso')!.status).toBe('green');
    expect(rows.find((r) => r.def.key === 'csat')!.status).toBe('none');
    expect(rows.find((r) => r.def.key === 'csat')!.delta).toBeNull();
  });
  it('limits to visible keys', () => {
    const rows = buildScorecard({ current: [], previous: {}, targets: [], visibleKeys: ['csat'] });
    expect(rows.map((r) => r.def.key)).toEqual(['csat']);
  });
  it('estimates revenue shortfall only', () => {
    const rows = buildScorecard({ current: [mv('revenue', 800000), mv('csat', 3)], previous: {}, targets: [hi('revenue', 1000000), hi('csat', 4)] });
    expect(estimateMissImpactCents(rows.find((r) => r.def.key === 'revenue')!)).toBe(200000);
    expect(estimateMissImpactCents(rows.find((r) => r.def.key === 'csat')!)).toBeNull();
  });
});

describe('trends', () => {
  it('aligns snapshots to weeks and leaves gaps as null', () => {
    const snaps = [
      { week_start: '2026-10-05', metric_key: 'csat' as const, value: 4.2 },
      { week_start: '2026-10-12', metric_key: 'csat' as const, value: null },
      { week_start: '2026-10-12', metric_key: 'dso' as const, value: 30 },
    ];
    expect(trendSeries(snaps, 'csat', ['2026-09-28', '2026-10-05', '2026-10-12'])).toEqual([null, 4.2, null]);
  });
});

describe('issues', () => {
  it('ranks live issues by dollar impact, unknown last', () => {
    const r = rankIssues([
      issue({ id: 'a', impact_cents: null }),
      issue({ id: 'b', impact_cents: 500000 }),
      issue({ id: 'c', impact_cents: 900000 }),
      issue({ id: 'd', status: 'solved', impact_cents: 99999999 }),
    ]);
    expect(r.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
  it('breaks ties by decision then age', () => {
    const r = rankIssues([
      issue({ id: 'old', impact_cents: 100, created_at: '2026-09-01T00:00:00Z' }),
      issue({ id: 'new', impact_cents: 100, created_at: '2026-10-01T00:00:00Z' }),
      issue({ id: 'dec', impact_cents: 100, needs_decision: true, created_at: '2026-10-05T00:00:00Z' }),
    ]);
    expect(r.map((i) => i.id)).toEqual(['dec', 'old', 'new']);
  });
  it('parses amount labels', () => {
    expect(parseAmountLabel('$4,200')).toBe(420000);
    expect(parseAmountLabel('$1.2k')).toBe(120000);
    expect(parseAmountLabel('3M')).toBe(300000000);
    expect(parseAmountLabel('no amount')).toBeNull();
    expect(parseAmountLabel(null)).toBeNull();
  });
  it('validates drafts and converts impact', () => {
    const base = { title: 'x', description: '', impact: '', needsDecision: false, ownerUserId: '' };
    expect(validateIssue(base)).toEqual({});
    expect(validateIssue({ ...base, title: '  ' }).title).toBeDefined();
    expect(validateIssue({ ...base, impact: 'abc' }).impact).toBeDefined();
    expect(validateIssue({ ...base, impact: '$1,500' })).toEqual({});
    expect(impactToCents('$1,500.50')).toBe(150050);
    expect(impactToCents('')).toBeNull();
  });
});

describe('priorities', () => {
  it('sorts off-track/overdue first, done last', () => {
    const s = sortPriorities(
      [
        prio({ id: 'done', status: 'done', due_date: '2026-10-01' }),
        prio({ id: 'later', due_date: '2026-12-31' }),
        prio({ id: 'overdue', due_date: '2026-10-01' }),
        prio({ id: 'off', status: 'off_track', due_date: '2026-11-30' }),
      ],
      '2026-10-24',
    );
    expect(s.map((p) => p.id)).toEqual(['overdue', 'off', 'later', 'done']);
  });
  it('validates drafts', () => {
    const ok = { title: 'Hire', description: '', ownerUserId: '', dueDate: '2026-12-01', goalId: '' };
    expect(validatePriority(ok)).toEqual({});
    expect(validatePriority({ ...ok, title: '' }).title).toBeDefined();
    expect(validatePriority({ ...ok, dueDate: '2026-13-45' }).dueDate).toBeDefined();
    expect(validatePriority({ ...ok, dueDate: '' }).dueDate).toBeDefined();
  });
});

describe('accountability chart', () => {
  const seats = [
    seat({ id: 'ceo', title: 'Owner', sort_order: 0, holder_name: 'Sam', metric_keys: ['revenue'] }),
    seat({ id: 'ops', parent_id: 'ceo', title: 'Operations', sort_order: 1 }),
    seat({ id: 'dispatch', parent_id: 'ops', title: 'Dispatch', sort_order: 0, metric_keys: ['utilization'] }),
  ];
  it('builds a nested tree with depths', () => {
    const t = buildSeatTree(seats);
    expect(t).toHaveLength(1);
    expect(t[0].children[0].children[0].title).toBe('Dispatch');
    expect(t[0].children[0].children[0].depth).toBe(2);
  });
  it('promotes orphans to roots and survives loops', () => {
    expect(buildSeatTree([seat({ id: 'a', parent_id: 'ghost' })])).toHaveLength(1);
    const looped = [seat({ id: 'a', parent_id: 'b' }), seat({ id: 'b', parent_id: 'a' })];
    expect(() => buildSeatTree(looped)).not.toThrow();
  });
  it('detects cycles', () => {
    expect(wouldCreateCycle(seats, 'ceo', 'dispatch')).toBe(true);
    expect(wouldCreateCycle(seats, 'ceo', 'ceo')).toBe(true);
    expect(wouldCreateCycle(seats, 'dispatch', 'ceo')).toBe(false);
    expect(wouldCreateCycle(seats, 'ops', null)).toBe(false);
  });
  it('reports gaps', () => {
    const g = chartGaps(seats);
    expect(g.vacantSeats).toEqual(['Operations', 'Dispatch']);
    expect(g.unownedMetrics).toContain('csat');
    expect(g.unownedMetrics).not.toContain('revenue');
  });
});

describe('agenda + timer', () => {
  const score = buildScorecard({
    current: [mv('booked_rate', 70), mv('csat', 4.8), mv('revenue', null, true)],
    previous: {},
    targets: [hi('booked_rate', 80), hi('csat', 4.5)],
  });
  it('builds the four segments in order', () => {
    const a = buildAgenda({
      scorecard: score,
      priorities: [prio({ id: 'p', status: 'off_track' }), prio({ id: 'd', status: 'done' })],
      issues: [issue({ id: 'big', impact_cents: 900000, needs_decision: true }), issue({ id: 'small', impact_cents: 100 })],
      today: '2026-10-24',
    });
    expect(a.map((s) => s.key)).toEqual(['scorecard', 'priorities', 'issues', 'decisions']);
    expect(a[0].items[0].title).toContain('Booked rate');
    expect(a[0].items[0].tone).toBe('danger');
    expect(a[0].items.some((i) => i.id === 'm:revenue')).toBe(false); // hidden metric never leaks
    expect(a[1].items).toHaveLength(1); // done excluded
    expect(a[2].items[0].id).toBe('i:big');
    expect(a[3].items.map((i) => i.id)).toEqual(['d:big']);
  });
  it('caps top issues at five', () => {
    const many = Array.from({ length: 9 }, (_, n) => issue({ id: `x${n}`, impact_cents: n * 100 }));
    expect(buildAgenda({ scorecard: [], priorities: [], issues: many, today: '2026-10-24' })[2].items).toHaveLength(5);
  });
  it('computes remaining time and overrun', () => {
    const start = '2026-10-24T10:00:00.000Z';
    const t = new Date(start).getTime();
    expect(segmentRemainingMs(10, start, t + 60_000)).toBe(9 * 60_000);
    expect(segmentRemainingMs(10, start, t + 11 * 60_000)).toBe(-60_000);
    expect(segmentRemainingMs(10, null, t)).toBe(10 * 60_000);
  });
  it('formats the clock including overrun', () => {
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(-5_000)).toBe('-00:05');
  });
  it('advances segments and ends cleanly', () => {
    const t0 = new Date('2026-10-24T10:00:00.000Z').getTime();
    let s = { current: 0, elapsedMs: [] as number[], segmentStartedAt: new Date(t0).toISOString() };
    s = advanceSegment(s, 2, t0 + 120_000);
    expect(s.current).toBe(1);
    expect(s.elapsedMs[0]).toBe(120_000);
    expect(s.segmentStartedAt).not.toBeNull();
    s = advanceSegment(s, 2, t0 + 180_000);
    expect(s.current).toBe(2);
    expect(s.segmentStartedAt).toBeNull();
    expect(advanceSegment(s, 2, t0 + 999_000).current).toBe(2);
  });
});

describe('action items', () => {
  it('validates', () => {
    expect(validateAction({ title: '', ownerUserId: '', dueDate: '' }, '2026-10-24').title).toBeDefined();
    expect(validateAction({ title: 'Call', ownerUserId: '', dueDate: '2026-10-01' }, '2026-10-24').dueDate).toBeDefined();
    expect(validateAction({ title: 'Call', ownerUserId: '', dueDate: '2026-10-24' }, '2026-10-24')).toEqual({});
    expect(validateAction({ title: 'Call', ownerUserId: '', dueDate: '' }, '2026-10-24')).toEqual({});
  });
});

describe('90-day review', () => {
  it('summarises a metric', () => {
    const r = reviewMetric('booked_rate', [60, 62, 64, 66, 82, 84, 86, 88], hi('booked_rate', 80));
    expect(r.weeksWithData).toBe(8);
    expect(r.weeksGreen).toBe(4);
    expect(r.greenPct).toBe(50);
    expect(r.trend).toBe('up');
    expect(r.improving).toBe(true);
    expect(r.last).toBe(88);
  });
  it('judges "improving" by direction (DSO falling is good)', () => {
    const r = reviewMetric('dso', [50, 48, 46, 44, 30, 28, 26, 24], lo('dso', 40));
    expect(r.trend).toBe('down');
    expect(r.improving).toBe(true);
  });
  it('is unknown with too little data', () => {
    const r = reviewMetric('csat', [null, 4.2, null], null);
    expect(r.trend).toBe('unknown');
    expect(r.improving).toBeNull();
    expect(r.greenPct).toBeNull();
  });
  it('builds the quarter rollup', () => {
    const weeks = pastWeeks('2026-10-19', 4);
    const q = buildQuarterReview({
      weeks,
      snapshots: weeks.map((w, n) => ({ week_start: w, metric_key: 'csat' as const, value: 4 + n * 0.1 })),
      targets: [hi('csat', 4.2)],
      priorities: [prio({ id: 'a', status: 'done' }), prio({ id: 'b', due_date: '2026-10-01' }), prio({ id: 'c', status: 'off_track' })],
      issues: [
        issue({ id: '1', status: 'solved', created_at: '2026-10-01T00:00:00Z', solved_at: '2026-10-05T00:00:00Z' }),
        issue({ id: '2', created_at: '2026-10-10T00:00:00Z' }),
      ],
      meetingsHeld: 3,
      actionItems: 7,
      today: '2026-10-24',
      sinceIso: '2026-07-26',
    });
    expect(q.metrics).toHaveLength(1);
    expect(q.priorities).toMatchObject({ total: 3, done: 1, offTrack: 1, overdue: 1, completionPct: 33 });
    expect(q.issues).toMatchObject({ created: 2, solved: 1, stillLive: 1, avgDaysToSolve: 4 });
    expect(q.meetings).toEqual({ held: 3, actionItems: 7 });
  });
});

describe('roles', () => {
  it('maps permissions to a role', () => {
    expect(cadenceRole({ isOwner: true, canViewAllJobs: false })).toBe('owner');
    expect(cadenceRole({ isOwner: false, canViewAllJobs: true })).toBe('manager');
    expect(cadenceRole({ isOwner: false, canViewAllJobs: false })).toBe('member');
  });
  it('hides meeting and review from members', () => {
    expect(tabsFor('member').map((t) => t.key)).toEqual(['scorecard', 'priorities', 'issues', 'chart']);
    expect(tabsFor('manager').map((t) => t.key)).toContain('meeting');
  });
});
