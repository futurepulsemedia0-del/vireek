import { describe, expect, it, vi } from 'vitest';

// Chainable PostgREST + functions.invoke fake. Records every call so the
// tests can assert account-owner scoping and which columns clients may write.
const fake = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    payloads: [] as unknown[],
    result: { data: null as unknown, error: null as unknown },
    invoke: { data: null as unknown, error: null as unknown },
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const record = (m: string) => (...args: unknown[]) => {
      state.log.push(`${table}.${m}:${args.map((a) => (typeof a === 'object' ? 'obj' : String(a))).join(',')}`);
      if (m === 'insert' || m === 'update') state.payloads.push(args[0]);
      return b;
    };
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'lt', 'order', 'limit']) b[m] = record(m);
    b.single = () => Promise.resolve(state.result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(state.result).then(res, rej);
    return b;
  };
  const supabase = {
    from: (t: string) => builder(t),
    functions: {
      invoke: (name: string, opts: { body: unknown }) => {
        state.log.push(`invoke:${name}:${JSON.stringify(opts.body)}`);
        return Promise.resolve(state.invoke);
      },
    },
  };
  return { state, supabase };
});

vi.mock('@/lib/supabase', () => ({ supabase: fake.supabase }));

import {
  createSchedule,
  defaultScheduleInput,
  deleteSchedule,
  describeCadence,
  formatHour,
  isValidEmail,
  listDeliveries,
  listSchedules,
  ordinal,
  parseRecipients,
  sendScheduleNow,
  setScheduleActive,
  statusMeta,
  toScheduleError,
  updateSchedule,
  validateScheduleInput,
  type ScheduleInput,
} from '@/lib/scheduledReports';
import * as client from '@/lib/reportBuilder';
import * as server from '../../supabase/functions/_shared/reports/engine';
import { buildReportEmail, escapeHtml, safeDisplayName, toCsv } from '../../supabase/functions/_shared/reports/email';

const OWNER = 'owner-1';
const reset = () => {
  fake.state.log = [];
  fake.state.payloads = [];
  fake.state.result = { data: null, error: null };
  fake.state.invoke = { data: null, error: null };
};
const valid = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  ...defaultScheduleInput('report-1'),
  timezone: 'Europe/London',
  recipients: ['a@b.com'],
  ...over,
});

describe('parseRecipients', () => {
  it('splits on commas, semicolons and whitespace, lower-cases and de-duplicates', () => {
    const r = parseRecipients('A@x.com, b@x.com;\nA@X.com   c@x.com');
    expect(r.emails).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(r.invalid).toEqual([]);
  });

  it('reports invalid addresses without dropping the valid ones', () => {
    const r = parseRecipients('ok@x.com not-an-email @x.com a@b');
    expect(r.emails).toEqual(['ok@x.com']);
    expect(r.invalid).toEqual(['not-an-email', '@x.com', 'a@b']);
    expect(isValidEmail('x@y.co')).toBe(true);
  });
});

describe('validateScheduleInput', () => {
  it('accepts a good schedule', () => {
    expect(validateScheduleInput(valid())).toBeNull();
  });
  it('rejects missing report, recipients, bad ranges and too many recipients', () => {
    expect(validateScheduleInput(valid({ reportId: '' }))).toMatch(/report/i);
    expect(validateScheduleInput(valid({ recipients: [] }))).toMatch(/recipient/i);
    expect(validateScheduleInput(valid({ recipients: ['nope'] }))).toMatch(/not a valid email/i);
    expect(validateScheduleInput(valid({ recipients: Array.from({ length: 11 }, (_, i) => `u${i}@x.com`) }))).toMatch(/up to 10/);
    expect(validateScheduleInput(valid({ frequency: 'monthly', monthDay: 31 }))).toMatch(/1–28/);
    expect(validateScheduleInput(valid({ frequency: 'weekly', weekday: 7 }))).toMatch(/day of the week/i);
    expect(validateScheduleInput(valid({ sendHour: 24 }))).toMatch(/time/i);
    expect(validateScheduleInput(valid({ timezone: ' ' }))).toMatch(/timezone/i);
  });
});

describe('formatting', () => {
  it('describes cadences', () => {
    expect(describeCadence({ frequency: 'weekly', weekday: 1, month_day: 1, send_hour: 8, timezone: 'UTC' })).toBe('Every Monday at 8:00 AM (UTC)');
    expect(describeCadence({ frequency: 'monthly', weekday: 1, month_day: 22, send_hour: 0, timezone: 'Asia/Baku' })).toBe('Monthly on the 22nd at 12:00 AM (Asia/Baku)');
    expect(formatHour(12)).toBe('12:00 PM');
    expect(formatHour(23)).toBe('11:00 PM');
  });
  it('handles ordinal edge cases', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 28].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '28th']);
  });
  it('maps every status to a label', () => {
    expect(statusMeta('sent').label).toBe('Delivered');
    expect(statusMeta('partial').label).toBe('Partly delivered');
    expect(statusMeta(null).label).toBe('Not run yet');
  });
  it('maps database error codes to friendly messages', () => {
    expect(toScheduleError({ code: '54000' }, 'x').message).toMatch(/limit of 25/);
    expect(toScheduleError({ code: '23503' }, 'x').message).toMatch(/no longer exists/);
    expect(toScheduleError({ code: '22023', message: 'Invalid recipient email: x' }, 'x').message).toBe('Invalid recipient email: x');
    expect(toScheduleError(null, 'fallback').message).toBe('fallback');
  });
});

describe('data access', () => {
  it('scopes every query to the account owner', async () => {
    reset();
    await listSchedules(OWNER);
    await listDeliveries(OWNER, { scheduleId: 's1', status: 'failed', before: '2026-01-01T00:00:00Z', limit: 10 });
    await deleteSchedule(OWNER, 's1');
    const log = fake.state.log.join('\n');
    expect(log).toContain(`scheduled_reports.eq:user_id,${OWNER}`);
    expect(log).toContain(`scheduled_report_deliveries.eq:user_id,${OWNER}`);
    expect(log).toContain('scheduled_report_deliveries.eq:schedule_id,s1');
    expect(log).toContain('scheduled_report_deliveries.eq:status,failed');
    expect(log).toContain('scheduled_report_deliveries.lt:created_at,2026-01-01T00:00:00Z');
    expect(log).toContain('scheduled_reports.delete');
  });

  it('never sends server-owned columns on create or update', async () => {
    reset();
    fake.state.result = { data: { id: 's1' }, error: null };
    await createSchedule(OWNER, valid());
    await updateSchedule(OWNER, 's1', valid());
    await setScheduleActive(OWNER, 's1', false);
    const [created, updated, toggled] = fake.state.payloads as Record<string, unknown>[];
    for (const forbidden of ['next_run_at', 'created_by', 'last_status', 'consecutive_failures', 'paused_reason']) {
      expect(forbidden in created).toBe(false);
      expect(forbidden in updated).toBe(false);
    }
    expect(created.user_id).toBe(OWNER);
    expect('user_id' in updated).toBe(false); // immutable on update
    expect(toggled).toEqual({ is_active: false });
    expect(fake.state.log.join('\n')).toContain(`scheduled_reports.eq:user_id,${OWNER}`);
  });

  it('surfaces database errors with friendly messages', async () => {
    reset();
    fake.state.result = { data: null, error: { code: '54000', message: 'x' } };
    await expect(createSchedule(OWNER, valid())).rejects.toThrow(/limit/i);
  });

  it('sendScheduleNow returns the delivery, and unwraps edge-function error bodies', async () => {
    reset();
    fake.state.invoke = { data: { delivery: { id: 'd1', status: 'sent' } }, error: null };
    const d = await sendScheduleNow('s1');
    expect(d).toMatchObject({ id: 'd1', status: 'sent' });
    expect(fake.state.log.join('\n')).toContain('invoke:scheduled-reports-run:{"action":"send_now","scheduleId":"s1"}');

    fake.state.invoke = {
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: { json: () => Promise.resolve({ detail: 'Please wait a minute before sending this report again.' }) } },
    };
    await expect(sendScheduleNow('s1')).rejects.toThrow(/wait a minute/);
  });
});

// ------------------------------------------------------------------
// The server engine is a port of the client engine. Same inputs must give
// the same outputs, or scheduled emails would disagree with the screen.
// ------------------------------------------------------------------
describe('client / server engine parity', () => {
  const local = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();
  const rows: client.ReportRow[] = [
    { id: '1', customer_name: 'Ann', service_type: 'AC repair', job_status: 'completed', invoice_amount: 200, scheduled_datetime: local(2026, 1, 15) },
    { id: '2', customer_name: 'Bob', service_type: 'AC repair', job_status: 'completed', invoice_amount: 150, scheduled_datetime: local(2026, 1, 31) },
    { id: '3', customer_name: 'Cy', service_type: 'Plumbing', job_status: 'cancelled', invoice_amount: null, scheduled_datetime: local(2026, 2, 1) },
    { id: '4', customer_name: '=SUM(1)', service_type: null, job_status: 'scheduled', invoice_amount: '90', scheduled_datetime: null },
  ];
  const base = client.defaultDefinition('jobs');
  const defs: client.ReportDefinition[] = [
    base,
    { ...base, groupBy: 'job_status', chart: 'bar' },
    { ...base, groupBy: 'service_type', metric: { fn: 'sum', field: 'invoice_amount' } },
    { ...base, groupBy: 'service_type', metric: { fn: 'avg', field: 'invoice_amount' }, sort: 'value_asc' },
    { ...base, groupBy: 'scheduled_datetime', dateBucket: 'week', sort: 'label_asc' },
    { ...base, groupBy: 'scheduled_datetime', dateBucket: 'month', sort: 'label_asc', limit: 10 },
    { ...base, filters: [{ field: 'job_status', op: 'eq', value: 'completed' }, { field: 'invoice_amount', op: 'gte', value: '160' }] },
  ];

  it('has identical entity catalogs', () => {
    expect(JSON.stringify(server.ENTITIES)).toBe(JSON.stringify(client.ENTITIES));
  });

  it('sanitises garbage identically', () => {
    for (const bad of [null, 'x', { groupBy: 'invoice_amount', metric: { fn: 'sum', field: 'customer_name' }, limit: 7 }, { columns: ['status', 'nope'], filters: [{ field: 'status', op: 'gt', value: '1' }] }]) {
      for (const entity of client.ENTITY_KEYS) {
        expect(server.sanitizeDefinition(bad, entity)).toEqual(client.sanitizeDefinition(bad, entity));
      }
    }
  });

  it('runs and exports identically', () => {
    for (const d of defs) {
      const c = client.runReport(rows, d);
      const s = server.runReport(rows, d);
      expect(s).toEqual(c);
      expect(server.toExportTable(s, d, 'USD')).toEqual(client.toExportTable(c, d, 'USD'));
    }
  });
});

describe('report email', () => {
  const calls = client.defaultDefinition('calls');
  const generatedAt = new Date(Date.UTC(2026, 0, 5, 12, 0));
  const common = { description: null, currency: 'USD', truncated: false, generatedAt, siteUrl: 'https://app.vireek.com' };

  it('escapes every database-supplied value', () => {
    const d = { ...calls, columns: ['caller_name', 'status'] };
    const rows = [{ id: '1', caller_name: '<script>alert(1)</script>', status: 'booked' }];
    const email = buildReportEmail({ ...common, companyName: 'Acme <HVAC>', reportName: 'Calls <b>', def: d, result: server.runReport(rows, d), csvAttached: true });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('Acme &lt;HVAC&gt;');
    expect(email.html).not.toContain('<b>');
    expect(email.subject).toBe('Calls <b> — Last 30 days'); // plain-text header, not HTML
  });

  it('points to the CSV only when one is attached and rows were cut', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), caller_name: `C${i}`, status: 'booked' }));
    const d = { ...calls, columns: ['caller_name', 'status'] };
    const withCsv = buildReportEmail({ ...common, companyName: null, reportName: 'R', def: d, result: server.runReport(many, d), csvAttached: true });
    const withoutCsv = buildReportEmail({ ...common, companyName: null, reportName: 'R', def: d, result: server.runReport(many, d), csvAttached: false });
    expect(withCsv.html).toContain('first 25 of 30 rows');
    expect(withCsv.html).toContain('attached CSV');
    expect(withoutCsv.html).not.toContain('attached CSV');
  });

  it('renders grouped reports, the empty state and the truncation warning', () => {
    const d = { ...calls, groupBy: 'status' };
    const rows = [{ id: '1', status: 'booked' }, { id: '2', status: 'booked' }, { id: '3', status: 'missed' }];
    const grouped = buildReportEmail({ ...common, companyName: 'Acme', reportName: 'By status', def: d, result: server.runReport(rows, d), csvAttached: true, truncated: true });
    expect(grouped.html).toContain('Booked');
    expect(grouped.html).toContain('more than 5,000');
    expect(grouped.text).toContain('Booked: 2');
    const empty = buildReportEmail({ ...common, companyName: 'Acme', reportName: 'Empty', def: d, result: server.runReport([], d), csvAttached: false });
    expect(empty.html).toContain('No data matched');
  });

  it('builds RFC 4180 CSV with a BOM and safe header names', () => {
    const csv = toCsv({ headers: ['A', 'B,C'], rows: [['x"y', null], ['line\nbreak', 3]] });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('A,"B,C"');
    expect(csv).toContain('"x""y",');
    expect(csv).toContain('"line\nbreak",3');
    expect(safeDisplayName('Acme, "Heat" <x@y>\n')).toBe('Acme Heat x y');
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });
});
