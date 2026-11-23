import { describe, expect, it } from 'vitest';
import { CLEAN_JOBS, CLEAN_SNAPSHOT, MESSY_SNAPSHOT, job } from './migrationValidation.fixtures';
import { buildValidationReport, formatCents, latestJobsByEntity, normalizeControlTotals, normalizeSnapshot, parseCountInput, parseMoneyToCents, reportToCsv } from './migrationValidation';

const byId = (r: ReturnType<typeof buildValidationReport>, id: string) => r.checks.find((c) => c.id === id);

describe('parseMoneyToCents', () => {
  it.each([
    ['$12,345.60', 1_234_560], ['1234.5', 123_450], ['(1,200.00)', -120_000], ['-50', -5000], ['-$50.01', -5001], ['0', 0], ['7', 700],
  ])('%s → %d', (input, cents) => expect(parseMoneyToCents(input)).toBe(cents));
  it.each(['', 'abc', '1.234,56', '12.345', '$-5', '(-5)', '1,23', '12 34'])('rejects %j', (input) => expect(parseMoneyToCents(input)).toBeNull());
  it('never produces float drift', () => expect(parseMoneyToCents('0.29')).toBe(29));
});

describe('parseCountInput / formatCents', () => {
  it('parses counts', () => { expect(parseCountInput('1,204')).toBe(1204); expect(parseCountInput('-1')).toBeNull(); expect(parseCountInput('1.5')).toBeNull(); });
  it('formats cents', () => { expect(formatCents(123_456_789)).toBe('$1,234,567.89'); expect(formatCents(-5)).toBe('-$0.05'); });
});

describe('latestJobsByEntity', () => {
  it('ignores rolled-back, failed, and other-source jobs, and keeps the newest', () => {
    const jobs = [
      job({ import_type: 'customers', id: 'old', created_at: '2029-01-01T00:00:00Z', total_rows: 1 }),
      job({ import_type: 'customers', id: 'new', created_at: '2029-02-01T00:00:00Z', total_rows: 2 }),
      job({ import_type: 'customers', id: 'rb', status: 'rolled_back', created_at: '2029-03-01T00:00:00Z' }),
      job({ import_type: 'customers', id: 'bad', status: 'failed', created_at: '2029-03-02T00:00:00Z' }),
      job({ import_type: 'customers', id: 'other', source: 'service_titan', created_at: '2029-03-03T00:00:00Z' }),
    ];
    expect(latestJobsByEntity(jobs, 'jobber').customers?.id).toBe('new');
  });
});

describe('buildValidationReport', () => {
  it('is not_started when nothing was imported', () => {
    const empty = { ...CLEAN_SNAPSHOT, customers: { ...CLEAN_SNAPSHOT.customers, imported: 0 }, jobs: { ...CLEAN_SNAPSHOT.jobs, imported: 0 }, invoices: { ...CLEAN_SNAPSHOT.invoices, count: 0 }, line_items: { count: 0 }, payments: { ...CLEAN_SNAPSHOT.payments, count: 0 } };
    expect(buildValidationReport(empty, []).verdict).toBe('not_started');
  });

  it('is ready on a clean import with matching control totals', () => {
    const r = buildValidationReport(CLEAN_SNAPSHOT, CLEAN_JOBS, {
      rows: { customers: 100, jobs: 400, invoices: 380, payments: 350 },
      jobRevenueCents: 12_345_678, invoiceTotalCents: 12_000_050, paymentsTotalCents: 11_850_025, openBalanceCents: 150_025,
    });
    expect(r.summary.fail).toBe(0);
    expect(r.summary.warn).toBe(0);
    expect(r.verdict).toBe('ready');
    expect(byId(r, 'money.invoice_total')?.status).toBe('pass');
  });

  it('fails on a one-cent money difference (zero tolerance)', () => {
    const r = buildValidationReport(CLEAN_SNAPSHOT, CLEAN_JOBS, { invoiceTotalCents: 12_000_051 });
    const c = byId(r, 'money.invoice_total');
    expect(c).toMatchObject({ status: 'fail', diff: -1, isMoney: true });
    expect(r.verdict).toBe('blocked');
  });

  it('fails when the file row count differs from the old system', () => {
    const r = buildValidationReport(CLEAN_SNAPSHOT, CLEAN_JOBS, { rows: { customers: 120 } });
    expect(byId(r, 'matches_source.customers')).toMatchObject({ status: 'fail', diff: -20 });
  });

  it('fails when a control count exists but nothing was imported for that entity', () => {
    const r = buildValidationReport(CLEAN_SNAPSHOT, CLEAN_JOBS.filter((j) => j.import_type !== 'jobs'), { rows: { jobs: 400 } });
    expect(byId(r, 'matches_source.jobs')?.status).toBe('fail');
  });

  it('fails when job counters do not add up to total rows', () => {
    const jobs = [job({ import_type: 'customers', total_rows: 10, created_count: 5, skipped_count: 1 })];
    expect(byId(buildValidationReport(CLEAN_SNAPSHOT, jobs), 'rows_accounted.customers')?.status).toBe('fail');
  });

  it('fails when imported rows vanished from the account', () => {
    const snap = { ...CLEAN_SNAPSHOT, customers: { ...CLEAN_SNAPSHOT.customers, imported: 10 } };
    expect(byId(buildValidationReport(snap, CLEAN_JOBS), 'present_in_account.customers')?.status).toBe('fail');
  });

  it('surfaces unmatched records, duplicates and unverified invoice lines as warnings', () => {
    const r = buildValidationReport(MESSY_SNAPSHOT, CLEAN_JOBS);
    expect(byId(r, 'unmatched.jobs_without_customer')).toMatchObject({ status: 'warn', actual: 7 });
    expect(byId(r, 'unmatched.invoices_without_customer')).toMatchObject({ status: 'warn', actual: 2 });
    expect(byId(r, 'duplicates.customer_groups')).toMatchObject({ status: 'warn', actual: 1 });
    expect(byId(r, 'money.invoice_lines_dont_add_up')).toMatchObject({ status: 'warn', actual: 4 });
    expect(r.verdict).toBe('review');
    expect(r.duplicateGroups).toHaveLength(1);
  });

  it('reports row errors from the import history as a warning', () => {
    const jobs = [...CLEAN_JOBS.filter((j) => j.import_type !== 'jobs'), job({ import_type: 'jobs', total_rows: 400, created_count: 395, error_count: 5, status: 'completed_with_errors' })];
    expect(byId(buildValidationReport(CLEAN_SNAPSHOT, jobs), 'row_errors.jobs')).toMatchObject({ status: 'warn', actual: 5 });
  });
});

describe('reportToCsv', () => {
  it('writes money as dollars, has no customer data, and guards formula injection', () => {
    const csv = reportToCsv(buildValidationReport(MESSY_SNAPSHOT, CLEAN_JOBS, { invoiceTotalCents: 12_000_051 }));
    expect(csv).toContain('money.invoice_total,money,,fail,120000.51,120000.50,-0.01,usd');
    expect(csv).not.toContain('Ana Ruiz');
    expect(csv.split('\r\n')[0]).toBe('check,group,entity,status,expected,actual,difference,unit');
  });
});

describe('normalizers', () => {
  it('normalizeSnapshot coerces garbage safely', () => {
    const s = normalizeSnapshot({ customers: { imported: '5', duplicate_groups: [{ kind: 'bogus' }, { kind: 'phone', size: 2, members: [{ id: 'a', name: 'X', imported: true }] }] }, jobs: null }, 'jobber');
    expect(s.customers.imported).toBe(5);
    expect(s.customers.duplicate_groups).toHaveLength(1);
    expect(s.jobs.revenue_cents).toBe(0);
    expect(normalizeSnapshot(undefined, 'csv').invoices.total_cents).toBe(0);
  });
  it('normalizeControlTotals drops invalid and non-integer values', () => {
    expect(normalizeControlTotals({ rows: { customers: 10, jobs: -1, invoices: 1.5, nope: 3 }, invoiceTotalCents: 100, paymentsTotalCents: '5', openBalanceCents: 0 }))
      .toEqual({ rows: { customers: 10 }, invoiceTotalCents: 100, openBalanceCents: 0 });
  });
});
