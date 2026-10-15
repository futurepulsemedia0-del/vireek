import { describe, expect, it, vi } from 'vitest';

// Minimal chainable PostgREST fake. It records every call so the tests can
// assert the account-owner scoping, the column whitelist and the paging.
const fake = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    log: [] as string[],
    error: null as null | { code: string; message: string },
  };
  const from = (table: string) => {
    state.log.push(`from:${table}`);
    const b: Record<string, unknown> = {};
    const chain =
      (label: string) =>
      (...args: unknown[]) => {
        state.log.push(`${label}:${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(',')}`);
        return b;
      };
    b.select = chain('select');
    b.eq = chain('eq');
    b.gte = chain('gte');
    b.order = chain('order');
    b.range = (f: number, t: number) => {
      state.log.push(`range:${f}-${t}`);
      return Promise.resolve(state.error ? { data: null, error: state.error } : { data: state.rows.slice(f, t + 1), error: null });
    };
    return b;
  };
  return { state, supabase: { from } };
});

vi.mock('@/lib/supabase', () => ({ supabase: fake.supabase }));

import {
  ENTITIES,
  MAX_ROWS,
  defaultDefinition,
  fetchReportRows,
  isFilterComplete,
  matchesFilter,
  rangeStart,
  runReport,
  safeCell,
  sanitizeDefinition,
  toExportTable,
  toReportError,
  validateDefinition,
  type ReportDefinition,
  type ReportRow,
} from '@/lib/reportBuilder';

const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

function def(over: Partial<ReportDefinition> & { entity?: ReportDefinition['entity'] } = {}): ReportDefinition {
  return { ...defaultDefinition(over.entity ?? 'jobs'), ...over };
}

const jobs: ReportRow[] = [
  { id: '1', customer_name: 'Ann', service_type: 'AC repair', job_status: 'completed', invoice_amount: 200, scheduled_datetime: local(2026, 1, 15) },
  { id: '2', customer_name: 'Bob', service_type: 'AC repair', job_status: 'completed', invoice_amount: 150, scheduled_datetime: local(2026, 1, 31) },
  { id: '3', customer_name: 'Cy', service_type: 'Plumbing', job_status: 'cancelled', invoice_amount: null, scheduled_datetime: local(2026, 2, 1) },
  { id: '4', customer_name: 'Di', service_type: null, job_status: 'scheduled', invoice_amount: '90', scheduled_datetime: null },
];

describe('sanitizeDefinition', () => {
  it('falls back to a safe default for garbage input', () => {
    for (const bad of [null, undefined, 'x', 42, [], true]) {
      expect(sanitizeDefinition(bad, 'calls')).toEqual(defaultDefinition('calls'));
    }
  });

  it('drops unknown columns, invalid filters and caps the lists', () => {
    const out = sanitizeDefinition(
      {
        columns: ['status', 'status', 'transcript', 42, 'sentiment'],
        filters: [
          { field: 'status', op: 'eq', value: 'booked' },
          { field: 'status', op: 'gt', value: '3' }, // op not valid for enum
          { field: 'nope', op: 'eq', value: 'x' },
          'junk',
          ...Array.from({ length: 30 }, () => ({ field: 'caller_name', op: 'contains', value: 'a' })),
        ],
      },
      'calls',
    );
    expect(out.columns).toEqual(['status', 'sentiment']);
    expect(out.filters).toHaveLength(10);
    expect(out.filters[0]).toEqual({ field: 'status', op: 'eq', value: 'booked' });
  });

  it('only allows numeric metric fields, non-numeric groupings and valid limits', () => {
    const bad = sanitizeDefinition(
      { groupBy: 'invoice_amount', metric: { fn: 'sum', field: 'customer_name' }, limit: 7, chart: 'bar', range: 'forever' },
      'jobs',
    );
    expect(bad.groupBy).toBeNull();
    expect(bad.metric).toEqual({ fn: 'count', field: null });
    expect(bad.limit).toBe(25);
    expect(bad.chart).toBe('none'); // charts need a grouping
    expect(bad.range).toBe('30d');

    const good = sanitizeDefinition(
      { groupBy: 'job_status', metric: { fn: 'avg', field: 'invoice_amount' }, limit: 50, chart: 'donut', range: '90d' },
      'jobs',
    );
    expect(good).toMatchObject({ groupBy: 'job_status', metric: { fn: 'avg', field: 'invoice_amount' }, limit: 50, chart: 'donut', range: '90d' });
  });

  it('is idempotent', () => {
    const once = sanitizeDefinition({ groupBy: 'status', chart: 'bar', filters: [{ field: 'status', op: 'eq', value: 'booked' }] }, 'calls');
    expect(sanitizeDefinition(once, 'calls')).toEqual(once);
  });
});

describe('validateDefinition', () => {
  it('requires columns when ungrouped and a field for non-count metrics', () => {
    expect(validateDefinition(def({ columns: [] }))).toMatch(/column/i);
    expect(validateDefinition(def({ columns: [], groupBy: 'job_status' }))).toBeNull();
    expect(validateDefinition(def({ groupBy: 'job_status', metric: { fn: 'sum', field: null } }))).toMatch(/numeric/i);
    expect(validateDefinition(def())).toBeNull();
  });
});

describe('filters', () => {
  it('matches strings case-insensitively and enums exactly', () => {
    const row = { customer_name: 'Ann Smith', job_status: 'completed' };
    expect(matchesFilter(row, { field: 'customer_name', op: 'contains', value: 'SMITH' }, 'jobs')).toBe(true);
    expect(matchesFilter(row, { field: 'job_status', op: 'eq', value: 'completed' }, 'jobs')).toBe(true);
    expect(matchesFilter(row, { field: 'job_status', op: 'neq', value: 'completed' }, 'jobs')).toBe(false);
    expect(matchesFilter({ job_status: null }, { field: 'job_status', op: 'neq', value: 'completed' }, 'jobs')).toBe(true);
  });

  it('compares numbers (including numeric strings) and rejects nulls', () => {
    const f = { field: 'invoice_amount', op: 'gte', value: '100' } as const;
    expect(matchesFilter({ invoice_amount: 100 }, f, 'jobs')).toBe(true);
    expect(matchesFilter({ invoice_amount: '99.5' }, f, 'jobs')).toBe(false);
    expect(matchesFilter({ invoice_amount: null }, f, 'jobs')).toBe(false);
  });

  it('treats date bounds as inclusive whole local days', () => {
    const after = { field: 'scheduled_datetime', op: 'after', value: '2026-01-15' } as const;
    const before = { field: 'scheduled_datetime', op: 'before', value: '2026-01-15' } as const;
    const noon = { scheduled_datetime: local(2026, 1, 15) };
    expect(matchesFilter(noon, after, 'jobs')).toBe(true);
    expect(matchesFilter(noon, before, 'jobs')).toBe(true);
    expect(matchesFilter({ scheduled_datetime: local(2026, 1, 16, 0) }, before, 'jobs')).toBe(false);
    expect(matchesFilter({ scheduled_datetime: null }, after, 'jobs')).toBe(false);
  });

  it('ignores filters that are still being typed', () => {
    expect(isFilterComplete({ field: 'invoice_amount', op: 'gt', value: '' }, 'jobs')).toBe(false);
    expect(isFilterComplete({ field: 'invoice_amount', op: 'gt', value: 'abc' }, 'jobs')).toBe(false);
    expect(matchesFilter({ invoice_amount: 1 }, { field: 'invoice_amount', op: 'gt', value: '' }, 'jobs')).toBe(true);
  });
});

describe('runReport', () => {
  it('lists filtered rows when ungrouped', () => {
    const r = runReport(jobs, def({ filters: [{ field: 'job_status', op: 'eq', value: 'completed' }] }));
    expect(r.kind).toBe('rows');
    expect(r.matched).toBe(2);
  });

  it('groups by an enum with a count, labelled and sorted high → low', () => {
    const r = runReport(jobs, def({ groupBy: 'job_status' }));
    expect(r.kind).toBe('grouped');
    expect(r.groups.map((g) => [g.label, g.value])).toEqual([
      ['Completed', 2],
      ['Cancelled', 1],
      ['Scheduled', 1],
    ]);
  });

  it('sums and averages numeric fields, ignoring nulls, and blanks empty groups', () => {
    const sum = runReport(jobs, def({ groupBy: 'service_type', metric: { fn: 'sum', field: 'invoice_amount' } }));
    expect(sum.groups[0]).toMatchObject({ label: 'AC repair', count: 2, value: 350 });
    const unknown = sum.groups.find((g) => g.label === 'Unknown');
    expect(unknown?.value).toBe(90); // numeric string is coerced

    const avg = runReport(jobs, def({ groupBy: 'service_type', metric: { fn: 'avg', field: 'invoice_amount' } }));
    expect(avg.groups.find((g) => g.label === 'AC repair')?.value).toBe(175);
    expect(avg.groups.find((g) => g.label === 'Plumbing')?.value).toBeNull();
  });

  it('buckets dates by month and week (Monday start) with "No date" last', () => {
    const month = runReport(jobs, def({ groupBy: 'scheduled_datetime', dateBucket: 'month', sort: 'label_asc' }));
    expect(month.groups.map((g) => [g.label, g.count])).toEqual([
      ['Jan 2026', 2],
      ['Feb 2026', 1],
      ['No date', 1],
    ]);
    const week = runReport(jobs, def({ groupBy: 'scheduled_datetime', dateBucket: 'week', sort: 'label_asc' }));
    expect(week.groups[0].label).toBe('Week of Jan 12'); // Thu Jan 15 → Monday Jan 12
  });

  it('applies the group limit and reports what was hidden', () => {
    const many: ReportRow[] = Array.from({ length: 40 }, (_, i) => ({ id: String(i), customer_name: `Customer ${i}` }));
    const r = runReport(many, def({ groupBy: 'customer_name', limit: 10 }));
    expect(r.groups).toHaveLength(10);
    expect(r.hiddenGroups).toBe(30);
  });

  it('returns an empty result for empty input', () => {
    expect(runReport([], def({ groupBy: 'job_status' }))).toMatchObject({ kind: 'grouped', matched: 0, groups: [] });
  });
});

describe('toExportTable', () => {
  it('exports grouped results with a metric column', () => {
    const d = def({ groupBy: 'service_type', metric: { fn: 'sum', field: 'invoice_amount' } });
    const t = toExportTable(runReport(jobs, d), d, 'USD');
    expect(t.headers).toEqual(['Service type', 'Rows', 'Sum of Invoice amount']);
    expect(t.rows[0]).toEqual(['AC repair', 2, 350]);
  });

  it('exports rows with readable values and neutralises spreadsheet formulas', () => {
    const d = defaultDefinition('calls');
    const rows: ReportRow[] = [
      { id: 'c1', call_datetime: local(2026, 3, 4, 9), caller_name: '=HYPERLINK("http://evil")', status: 'new_lead', duration_seconds: 125 },
      { id: 'c2', call_datetime: null, caller_name: null, status: null, duration_seconds: null },
    ];
    const t = toExportTable(runReport(rows, d), d, 'USD');
    expect(t.headers).toEqual(['Call time', 'Caller', 'Status', 'Duration']);
    expect(t.rows[0]).toEqual(['2026-03-04 09:00', `'=HYPERLINK("http://evil")`, 'New lead', 125]);
    expect(t.rows[1]).toEqual([null, null, null, null]);
  });

  it('safeCell only prefixes dangerous leading characters', () => {
    expect(safeCell('=1+1')).toBe("'=1+1");
    expect(safeCell('+44 20')).toBe("'+44 20");
    expect(safeCell('@cmd')).toBe("'@cmd");
    expect(safeCell('Plain')).toBe('Plain');
  });
});

describe('rangeStart', () => {
  const now = new Date(2026, 5, 15, 14, 30);
  it('returns local start-of-day boundaries', () => {
    expect(rangeStart('7d', now)).toEqual(new Date(2026, 5, 8));
    expect(rangeStart('12m', now)).toEqual(new Date(2025, 5, 15));
    expect(rangeStart('all', now)).toBeNull();
  });
});

describe('fetchReportRows', () => {
  const OWNER = 'owner-123';
  const makeRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
  const reset = (rows: Record<string, unknown>[]) => {
    fake.state.rows = rows;
    fake.state.log = [];
    fake.state.error = null;
  };

  it('scopes to the account owner, whitelists columns and applies the date range', async () => {
    reset(makeRows(3));
    const out = await fetchReportRows('calls', OWNER, '30d');
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(false);
    const log = fake.state.log.join('\n');
    expect(log).toContain('from:calls');
    expect(log).toContain(`eq:user_id,${OWNER}`);
    expect(log).toContain('gte:call_datetime');
    const select = fake.state.log.find((l) => l.startsWith('select:')) ?? '';
    expect(select).toContain('call_datetime');
    expect(select).not.toContain('transcript');
    expect(select).not.toContain('recording_url');
    for (const e of Object.values(ENTITIES)) {
      expect(e.fields.every((f) => !/transcript|recording|signature|photo/i.test(f.key))).toBe(true);
    }
  });

  it('omits the date filter for "all time"', async () => {
    reset(makeRows(1));
    await fetchReportRows('leads', OWNER, 'all');
    expect(fake.state.log.some((l) => l.startsWith('gte:'))).toBe(false);
  });

  it('pages through PostgREST\'s 1000-row cap', async () => {
    reset(makeRows(1500));
    const out = await fetchReportRows('jobs', OWNER, 'all');
    expect(out.rows).toHaveLength(1500);
    expect(out.truncated).toBe(false);
    const ranges = fake.state.log.filter((l) => l.startsWith('range:'));
    expect(ranges).toEqual(['range:0-999', 'range:1000-1999']);
  });

  it('flags truncation exactly when more than MAX_ROWS exist', async () => {
    reset(makeRows(MAX_ROWS + 800));
    const over = await fetchReportRows('jobs', OWNER, 'all');
    expect(over.rows).toHaveLength(MAX_ROWS);
    expect(over.truncated).toBe(true);

    reset(makeRows(MAX_ROWS));
    const exact = await fetchReportRows('jobs', OWNER, 'all');
    expect(exact.rows).toHaveLength(MAX_ROWS);
    expect(exact.truncated).toBe(false);
  });

  it('turns database errors into friendly messages', async () => {
    reset([]);
    fake.state.error = { code: '42501', message: 'rls' };
    await expect(fetchReportRows('calls', OWNER, 'all')).rejects.toThrow(/permission/i);
    expect(toReportError({ code: '23505' }, 'x').message).toMatch(/already exists/i);
    expect(toReportError(null, 'fallback').message).toBe('fallback');
  });
});
