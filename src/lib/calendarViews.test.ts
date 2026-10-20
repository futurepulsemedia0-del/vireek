import { describe, it, expect } from 'vitest';
import type { Job, TeamMember } from '@/lib/supabase';
import {
  addMonths,
  allStatusOptions,
  buildAgenda,
  buildLegend,
  buildMonthGrid,
  buildResourceWeek,
  classifyTrade,
  compareJobs,
  describeFilters,
  filterJobs,
  formatClockCompact,
  formatDuration,
  groupJobsByDay,
  isExtendedView,
  moveGridFocus,
  parseCalendarPrefs,
  periodLabel,
  resolveJobColor,
  shiftAnchor,
  splitOverflow,
  startOfWeekMonday,
  statusColor,
  technicianColor,
  viewForShortcut,
} from './calendarViews';

function at(y: number, m: number, d: number, h = 9, min = 0): string {
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

function makeJob(o: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    user_id: 'owner-1',
    customer_name: 'Jane Doe',
    service_type: 'Plumbing repair',
    scheduled_datetime: at(2026, 10, 12, 9),
    duration_minutes: 60,
    assigned_technician_id: 'tech-1',
    job_status: 'scheduled',
    tags: [],
    ...o,
  } as Job;
}

function makeTech(o: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'tech-1',
    member_name: 'Maria Lopez',
    member_email: 'maria@example.com',
    role: 'technician',
    max_jobs_per_day: 6,
    ...o,
  } as TeamMember;
}

const MARIA = makeTech();
const OMAR = makeTech({ id: 'tech-2', member_name: 'Omar Said', member_email: 'omar@example.com', max_jobs_per_day: 2 });
const LANES = [
  { key: 'unassigned', technician: null as TeamMember | null },
  { key: MARIA.id, technician: MARIA },
  { key: OMAR.id, technician: OMAR },
];

describe('dates', () => {
  it('addMonths clamps to the last day of shorter months', () => {
    expect(addMonths(new Date(2026, 0, 31), 1).getDate()).toBe(28);
    expect(addMonths(new Date(2028, 0, 31), 1).getDate()).toBe(29);
    expect(addMonths(new Date(2026, 11, 15), 1).getFullYear()).toBe(2027);
    expect(addMonths(new Date(2026, 0, 15), -1).getMonth()).toBe(11);
  });

  it('startOfWeekMonday treats Sunday as the end of the week', () => {
    expect(startOfWeekMonday(new Date(2026, 9, 18)).getDate()).toBe(12); // Sun Oct 18 → Mon Oct 12
    expect(startOfWeekMonday(new Date(2026, 9, 19)).getDate()).toBe(19); // Mon stays
  });

  it('formats durations and compact clock times', () => {
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(150)).toBe('2h 30m');
    expect(formatClockCompact(at(2026, 10, 12, 9, 30))).toBe('9:30a');
    expect(formatClockCompact(at(2026, 10, 12, 15, 0))).toBe('3:00p');
    expect(formatClockCompact(null)).toBe('Unscheduled');
  });
});

describe('navigation', () => {
  const anchor = new Date(2026, 9, 31); // Oct 31
  it('steps by the right unit for each view', () => {
    expect(shiftAnchor('month', anchor, 1).getMonth()).toBe(10);
    expect(shiftAnchor('month', anchor, 1).getDate()).toBe(30); // Nov has 30 days
    expect(shiftAnchor('agenda', anchor, -1).getMonth()).toBe(8);
    expect(shiftAnchor('week', anchor, 1).getDate()).toBe(7);
    expect(shiftAnchor('resources', anchor, -1).getDate()).toBe(24);
    expect(shiftAnchor('day', anchor, 1).getMonth()).toBe(10);
  });

  it('labels each view', () => {
    expect(periodLabel('month', new Date(2026, 9, 5))).toBe('October 2026');
    expect(periodLabel('agenda', new Date(2026, 9, 5))).toBe('October 2026');
    expect(periodLabel('week', new Date(2026, 9, 14))).toBe('Oct 12 – 18, 2026');
    expect(periodLabel('week', new Date(2026, 9, 29))).toBe('Oct 26 – Nov 1, 2026');
    expect(periodLabel('day', new Date(2026, 9, 14))).toContain('October 14');
  });

  it('maps shortcut keys to views', () => {
    expect(viewForShortcut('m')).toBe('month');
    expect(viewForShortcut('A')).toBe('agenda');
    expect(viewForShortcut('r')).toBe('resources');
    expect(viewForShortcut('x')).toBeNull();
    expect(isExtendedView('month')).toBe(true);
    expect(isExtendedView('week')).toBe(false);
  });

  it('moves grid focus like the WAI-ARIA grid pattern', () => {
    const d = new Date(2026, 9, 14); // Wed
    expect(moveGridFocus(d, 'ArrowRight')!.getDate()).toBe(15);
    expect(moveGridFocus(d, 'ArrowLeft')!.getDate()).toBe(13);
    expect(moveGridFocus(d, 'ArrowDown')!.getDate()).toBe(21);
    expect(moveGridFocus(d, 'ArrowUp')!.getDate()).toBe(7);
    expect(moveGridFocus(d, 'Home')!.getDate()).toBe(12);
    expect(moveGridFocus(d, 'End')!.getDate()).toBe(18);
    expect(moveGridFocus(d, 'PageDown')!.getMonth()).toBe(10);
    expect(moveGridFocus(d, 'PageUp')!.getMonth()).toBe(8);
    expect(moveGridFocus(d, 'a')).toBeNull();
  });
});

describe('buildMonthGrid', () => {
  it('covers the month in Monday-first weeks of 7', () => {
    const weeks = buildMonthGrid(new Date(2026, 9, 14), new Date(2026, 9, 14));
    expect(weeks.length).toBe(5); // Sep 28 – Nov 1
    weeks.forEach((w) => expect(w).toHaveLength(7));
    expect(weeks[0][0].key).toBe('2026-09-28');
    expect(weeks[0][0].inMonth).toBe(false);
    expect(weeks[4][6].key).toBe('2026-11-01');
    expect(weeks.flat().filter((c) => c.inMonth)).toHaveLength(31);
    expect(weeks.flat().filter((c) => c.isToday).map((c) => c.key)).toEqual(['2026-10-14']);
  });

  it('uses only the rows it needs (4 for Feb 2027, 6 for Aug 2026)', () => {
    expect(buildMonthGrid(new Date(2027, 1, 10))).toHaveLength(4);
    expect(buildMonthGrid(new Date(2026, 7, 10))).toHaveLength(6);
  });

  it('marks weekends', () => {
    const weeks = buildMonthGrid(new Date(2026, 9, 14));
    expect(weeks[0].map((c) => c.isWeekend)).toEqual([false, false, false, false, false, true, true]);
  });
});

describe('grouping, sorting and overflow', () => {
  const a = makeJob({ id: 'a', customer_name: 'Zed', scheduled_datetime: at(2026, 10, 12, 14) });
  const b = makeJob({ id: 'b', customer_name: 'Amy', scheduled_datetime: at(2026, 10, 12, 9) });
  const c = makeJob({ id: 'c', customer_name: 'Bob', scheduled_datetime: at(2026, 10, 13, 9) });
  const none = makeJob({ id: 'n', scheduled_datetime: null });
  const bad = makeJob({ id: 'x', scheduled_datetime: 'not-a-date' });

  it('buckets by local day, sorted, skipping unscheduled / invalid', () => {
    const map = groupJobsByDay([a, b, c, none, bad]);
    expect([...map.keys()].sort()).toEqual(['2026-10-12', '2026-10-13']);
    expect(map.get('2026-10-12')!.map((j) => j.id)).toEqual(['b', 'a']);
  });

  it('breaks ties by customer name then id', () => {
    const t = at(2026, 10, 12, 9);
    const x = makeJob({ id: '2', customer_name: 'Same', scheduled_datetime: t });
    const y = makeJob({ id: '1', customer_name: 'Same', scheduled_datetime: t });
    expect([x, y].sort(compareJobs).map((j) => j.id)).toEqual(['1', '2']);
  });

  it('splits overflow without mutating', () => {
    const items = [1, 2, 3, 4, 5];
    expect(splitOverflow(items, 3)).toEqual({ visible: [1, 2, 3], hidden: 2 });
    expect(splitOverflow(items, 10)).toEqual({ visible: items, hidden: 0 });
    expect(splitOverflow(items, -1)).toEqual({ visible: [], hidden: 5 });
    expect(items).toHaveLength(5);
  });
});

describe('filterJobs', () => {
  const jobs = [
    makeJob({ id: '1', assigned_technician_id: 'tech-1', job_status: 'scheduled' }),
    makeJob({ id: '2', assigned_technician_id: 'tech-2', job_status: 'in_progress' }),
    makeJob({ id: '3', assigned_technician_id: null, job_status: 'on_hold' }),
  ];
  const ids = (list: Job[]) => list.map((j) => j.id);

  it('filters by technician', () => {
    expect(ids(filterJobs(jobs, { technician: 'all' }))).toEqual(['1', '2', '3']);
    expect(ids(filterJobs(jobs, { technician: 'unassigned' }))).toEqual(['3']);
    expect(ids(filterJobs(jobs, { technician: 'tech-2' }))).toEqual(['2']);
  });

  it('filters by status, including workflow statuses; empty set = all', () => {
    expect(ids(filterJobs(jobs, { technician: 'all', statuses: new Set(['on_hold', 'scheduled']) }))).toEqual(['1', '3']);
    expect(ids(filterJobs(jobs, { technician: 'all', statuses: new Set() }))).toEqual(['1', '2', '3']);
    expect(ids(filterJobs(jobs, { technician: 'all', statuses: null }))).toEqual(['1', '2', '3']);
  });

  it('combines both filters', () => {
    expect(ids(filterJobs(jobs, { technician: 'tech-1', statuses: new Set(['in_progress']) }))).toEqual([]);
  });

  it('describes active filters for the print header', () => {
    expect(describeFilters(null, [])).toBe('');
    expect(describeFilters('Maria Lopez', ['Scheduled', 'On hold'])).toBe('Maria Lopez · Scheduled, On hold');
    expect(describeFilters(null, ['Scheduled'])).toBe('Scheduled');
  });
});

describe('buildAgenda', () => {
  const jobs = [
    makeJob({ id: 'a', scheduled_datetime: at(2026, 10, 13, 9), assigned_technician_id: 'tech-1' }),
    makeJob({ id: 'b', scheduled_datetime: at(2026, 10, 12, 15), assigned_technician_id: null }),
    makeJob({ id: 'c', scheduled_datetime: at(2026, 10, 12, 8), assigned_technician_id: 'tech-2' }),
    makeJob({ id: 'd', scheduled_datetime: at(2026, 11, 2, 8), assigned_technician_id: 'tech-1' }), // other month
    makeJob({ id: 'e', scheduled_datetime: at(2026, 10, 20, 8), assigned_technician_id: 'ghost' }),
  ];
  const anchor = new Date(2026, 9, 1);

  it('groups by date, omits empty days and other months', () => {
    const sections = buildAgenda(jobs, anchor, 'date', LANES);
    expect(sections.map((s) => s.key)).toEqual(['2026-10-12', '2026-10-13', '2026-10-20']);
    expect(sections[0].jobs.map((j) => j.id)).toEqual(['c', 'b']);
    expect(sections[0].subtitle).toBe('2 jobs');
    expect(sections[1].subtitle).toBe('1 job');
  });

  it('groups by technician in lane order and never drops orphaned jobs', () => {
    const sections = buildAgenda(jobs, anchor, 'technician', LANES);
    expect(sections.map((s) => s.title)).toEqual(['Unassigned', 'Maria Lopez', 'Omar Said', 'Other technicians']);
    expect(sections[3].jobs.map((j) => j.id)).toEqual(['e']);
    const total = sections.reduce((n, s) => n + s.jobs.length, 0);
    expect(total).toBe(4);
  });

  it('returns nothing for an empty month', () => {
    expect(buildAgenda(jobs, new Date(2027, 5, 1), 'date', LANES)).toEqual([]);
  });
});

describe('buildResourceWeek', () => {
  const weekDays = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 12 + i));
  const jobs = [
    makeJob({ id: '1', scheduled_datetime: at(2026, 10, 12, 9), assigned_technician_id: 'tech-2', duration_minutes: 90 }),
    makeJob({ id: '2', scheduled_datetime: at(2026, 10, 12, 11), assigned_technician_id: 'tech-2', duration_minutes: null }),
    makeJob({ id: '3', scheduled_datetime: at(2026, 10, 12, 14), assigned_technician_id: 'tech-2' }),
    makeJob({ id: '4', scheduled_datetime: at(2026, 10, 14, 9), assigned_technician_id: null }),
    makeJob({ id: '5', scheduled_datetime: at(2026, 10, 15, 9), assigned_technician_id: 'ghost' }), // not a lane → Unassigned
  ];
  const rows = buildResourceWeek(jobs, weekDays, LANES);

  it('builds a row per lane and a cell per day', () => {
    expect(rows.map((r) => r.key)).toEqual(['unassigned', 'tech-1', 'tech-2']);
    rows.forEach((r) => expect(r.cells).toHaveLength(7));
  });

  it('totals jobs and minutes (null duration counts as 60)', () => {
    const omar = rows[2];
    expect(omar.totalJobs).toBe(3);
    expect(omar.totalMinutes).toBe(90 + 60 + 60);
    expect(omar.cells[0].minutes).toBe(210);
  });

  it('flags only days over max_jobs_per_day (Omar: 2)', () => {
    expect(rows[2].cells[0].overbooked).toBe(true);
    expect(rows[2].cells[1].overbooked).toBe(false);
    expect(rows[0].cells.every((c) => !c.overbooked)).toBe(true); // Unassigned has no cap
  });

  it('puts jobs of unknown technicians in the Unassigned lane', () => {
    expect(rows[0].totalJobs).toBe(2);
  });
});

describe('colour coding', () => {
  it('resolves legacy and workflow statuses, with a neutral fallback', () => {
    expect(statusColor('scheduled').dot).toBe('bg-accent');
    expect(statusColor('waiting_on_parts').label).toBe('Waiting on parts');
    expect(statusColor('something_new')).toEqual({ key: 'something_new', label: 'Something new', dot: 'bg-text-secondary' });
    const keys = allStatusOptions().map((o) => o.key);
    expect(keys).toHaveLength(11);
    expect(new Set(keys).size).toBe(11);
  });

  it('classifies trades from service type and tags', () => {
    expect(classifyTrade({ service_type: 'AC not cooling', tags: [] })).toBe('hvac');
    expect(classifyTrade({ service_type: 'Furnace tune-up', tags: [] })).toBe('hvac');
    expect(classifyTrade({ service_type: 'Burst pipe', tags: [] })).toBe('plumbing');
    expect(classifyTrade({ service_type: 'Panel upgrade', tags: [] })).toBe('electrical');
    expect(classifyTrade({ service_type: 'Roof leak', tags: [] })).toBe('roofing'); // roofing beats plumbing's "leak"
    expect(classifyTrade({ service_type: 'Water damage cleanup', tags: [] })).toBe('restoration');
    expect(classifyTrade({ service_type: 'Lockout', tags: [] })).toBe('locksmith');
    expect(classifyTrade({ service_type: null, tags: ['plumbing'] })).toBe('plumbing');
    expect(classifyTrade({ service_type: 'Inspection', tags: [] })).toBe('general');
    expect(classifyTrade({ service_type: null, tags: undefined as unknown as string[] })).toBe('general');
  });

  it('gives each technician a stable colour matching the page palette order', () => {
    const techs = [MARIA, OMAR];
    expect(technicianColor(techs, 'tech-1').dot).toBe('bg-accent');
    expect(technicianColor(techs, 'tech-2').dot).toBe('bg-cta');
    expect(technicianColor(techs, null).label).toBe('Unassigned');
    expect(technicianColor(techs, 'ghost').label).toBe('Other technician');
    const many = Array.from({ length: 8 }, (_, i) => makeTech({ id: `t${i}` }));
    expect(technicianColor(many, 't6').dot).toBe(technicianColor(many, 't0').dot); // palette wraps
  });

  it('resolves a job colour by mode', () => {
    const job = makeJob({ service_type: 'Furnace repair', job_status: 'en_route' });
    expect(resolveJobColor(job, 'status', [MARIA]).label).toBe('En route');
    expect(resolveJobColor(job, 'trade', [MARIA]).label).toBe('HVAC');
    expect(resolveJobColor(job, 'technician', [MARIA]).label).toBe('Maria Lopez');
  });

  it('builds a legend of only the colours in use, most common first', () => {
    const jobs = [
      makeJob({ id: '1', job_status: 'scheduled' }),
      makeJob({ id: '2', job_status: 'scheduled' }),
      makeJob({ id: '3', job_status: 'completed' }),
    ];
    const legend = buildLegend(jobs, 'status', [MARIA]);
    expect(legend.map((l) => [l.label, l.count])).toEqual([
      ['Scheduled', 2],
      ['Completed', 1],
    ]);
    expect(buildLegend([], 'trade', [])).toEqual([]);
  });
});

describe('parseCalendarPrefs', () => {
  it('falls back to defaults for missing or corrupt storage', () => {
    const defaults = { view: 'week', colorMode: 'status', agendaGroupBy: 'date' };
    expect(parseCalendarPrefs(null)).toEqual(defaults);
    expect(parseCalendarPrefs('')).toEqual(defaults);
    expect(parseCalendarPrefs('{not json')).toEqual(defaults);
    expect(parseCalendarPrefs('null')).toEqual(defaults);
  });

  it('keeps valid fields and replaces invalid ones individually', () => {
    expect(parseCalendarPrefs(JSON.stringify({ view: 'month', colorMode: 'trade', agendaGroupBy: 'technician' }))).toEqual({
      view: 'month',
      colorMode: 'trade',
      agendaGroupBy: 'technician',
    });
    expect(parseCalendarPrefs(JSON.stringify({ view: 'year', colorMode: 'trade' }))).toEqual({
      view: 'week',
      colorMode: 'trade',
      agendaGroupBy: 'date',
    });
  });
});
