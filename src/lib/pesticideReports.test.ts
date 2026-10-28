import { describe, it, expect } from 'vitest';
import {
  csvCell,
  describeWindow,
  detailCsv,
  formatAmount,
  monthlyBreakdown,
  normalizeReport,
  parseDateInput,
  productSummaryCsv,
  readinessIssues,
  reportFileName,
  resolvePeriod,
  rowFlags,
  toCsv,
  type UsageReportRow,
} from './pesticideReports';

const row = (over: Partial<UsageReportRow> = {}): UsageReportRow => ({
  id: 'e1', performed_at: '2027-03-15T14:30:00Z', job_id: 'j1', customer_id: 'c1', site_address: '12 Oak St, Springfield',
  technician_id: 't1', technician_name: 'Sam Rivera', credential_type: 'pesticide_applicator', credential_number: 'PA-1001',
  product_id: 'p1', product_name: 'Talstar P', product_epa_reg: '279-3206', product_restricted: false, reentry_until: null,
  notes: null, amount: 2, amount_unit: 'fl_oz', area_sqft: 1000,
  data: { method: 'Spray', application_site: 'Exterior', target_pests: ['Ants', 'Spiders'], ppe_used: true, customer_notified: true, wind_mph: 4, temp_f: 72 },
  ...over,
});

describe('resolvePeriod', () => {
  const now = new Date(2027, 4, 20, 10, 0, 0); // 20 May 2027, local
  it('builds half-open local windows', () => {
    const p = resolvePeriod('last_month', now);
    expect('error' in p).toBe(false);
    if ('error' in p) return;
    expect(p.label).toBe('2027-04-01 – 2027-04-30');
    expect(new Date(p.from).getTime()).toBe(new Date(2027, 3, 1).getTime());
    expect(new Date(p.to).getTime()).toBe(new Date(2027, 4, 1).getTime());
  });
  it('quarters, year-to-date and last year', () => {
    const q = resolvePeriod('this_quarter', now);
    const lq = resolvePeriod('last_quarter', now);
    const ytd = resolvePeriod('year_to_date', now);
    const ly = resolvePeriod('last_year', now);
    expect('label' in q && q.label).toBe('2027-04-01 – 2027-06-30');
    expect('label' in lq && lq.label).toBe('2027-01-01 – 2027-03-31');
    expect('label' in ytd && ytd.label).toBe('2027-01-01 – 2027-05-20');
    expect('label' in ly && ly.label).toBe('2026-01-01 – 2026-12-31');
  });
  it('last quarter in January rolls into the previous year', () => {
    const p = resolvePeriod('last_quarter', new Date(2027, 0, 10));
    expect('label' in p && p.label).toBe('2026-10-01 – 2026-12-31');
  });
  it('validates custom ranges', () => {
    expect(resolvePeriod('custom', now, { from: '2027-02-31', to: '2027-03-01' })).toEqual({ error: 'Enter a valid start and end date.' });
    expect(resolvePeriod('custom', now, { from: '2027-03-02', to: '2027-03-01' })).toEqual({ error: 'The end date must be on or after the start date.' });
    expect(resolvePeriod('custom', now, { from: '2020-01-01', to: '2027-01-01' })).toEqual({ error: 'A report can cover at most 3 years.' });
    const ok = resolvePeriod('custom', now, { from: '2027-03-01', to: '2027-03-01' });
    expect('label' in ok && ok.label).toBe('2027-03-01 – 2027-03-01');
  });
  it('parseDateInput rejects overflow dates', () => {
    expect(parseDateInput('2027-13-01')).toBeNull();
    expect(parseDateInput('2027-2-1')).toBeNull();
    expect(parseDateInput('2028-02-29')).not.toBeNull();
  });
  it('describeWindow shows the inclusive last day', () => {
    const p = resolvePeriod('last_month', now);
    if ('error' in p) throw new Error('unexpected');
    expect(describeWindow(p.from, p.to)).toBe('2027-04-01 – 2027-04-30');
    expect(describeWindow('x', 'y')).toBe('—');
  });
});

describe('normalizeReport', () => {
  it('survives garbage and fills defaults', () => {
    const r = normalizeReport(null);
    expect(r).toMatchObject({ entry_count: 0, truncated: false, rows: [], by_product: [], by_applicator: [] });
    expect(r.totals.missing_licence).toBe(0);
  });
  it('coerces numeric strings and keeps nulls', () => {
    const r = normalizeReport({ entry_count: '3', rows: [{ id: 'a', amount: '1.5', area_sqft: null, product_restricted: true, data: { ppe_used: false } }], by_product: [{ product_name: 'X', total_amount: '4' }] });
    expect(r.entry_count).toBe(3);
    expect(r.rows[0]).toMatchObject({ amount: 1.5, area_sqft: null, product_restricted: true });
    expect(r.by_product[0].total_amount).toBe(4);
  });
});

describe('rowFlags / readinessIssues', () => {
  it('flags only real gaps', () => {
    expect(rowFlags(row())).toEqual([]);
    expect(rowFlags(row({ credential_number: null, area_sqft: null, product_epa_reg: null, data: { ppe_used: false, customer_notified: false } }))).toEqual([
      'no_licence', 'no_area', 'no_epa_reg', 'ppe_not_confirmed', 'customer_not_notified',
    ]);
    // an unanswered optional boolean is not a failure
    expect(rowFlags(row({ data: {} }))).toEqual([]);
  });
  it('lists only non-zero issues', () => {
    const r = normalizeReport({ totals: { missing_licence: 2, ppe_not_confirmed: 1 } });
    expect(readinessIssues(r).map((i) => [i.flag, i.count])).toEqual([['no_licence', 2], ['ppe_not_confirmed', 1]]);
  });
});

describe('monthlyBreakdown', () => {
  it('groups by month in the given time zone, oldest first', () => {
    const rows = [
      row({ id: 'a', performed_at: '2027-03-31T23:30:00Z', product_restricted: true }),
      row({ id: 'b', performed_at: '2027-04-02T10:00:00Z' }),
      row({ id: 'c', performed_at: '2027-03-01T10:00:00Z' }),
    ];
    expect(monthlyBreakdown(rows, 'UTC')).toEqual([
      { month: '2027-03', applications: 2, restricted: 1 },
      { month: '2027-04', applications: 1, restricted: 0 },
    ]);
    // 23:30 UTC on Mar 31 is already April in Tokyo
    expect(monthlyBreakdown(rows, 'Asia/Tokyo').map((b) => b.month)).toEqual(['2027-03', '2027-04']);
    expect(monthlyBreakdown(rows, 'Asia/Tokyo')[1].applications).toBe(2);
  });
});

describe('csv', () => {
  it('escapes RFC 4180 specials and neutralizes spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-5 notes')).toBe("'-5 notes");
    expect(csvCell(-5)).toBe('-5'); // real numbers are untouched
    expect(csvCell(true)).toBe('Yes');
    expect(csvCell(null)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });
  it('uses CRLF line breaks', () => {
    expect(toCsv(['a', 'b'], [[1, 2]])).toBe('a,b\r\n1,2');
  });
  it('detail CSV: one line per application with local date/time', () => {
    const report = normalizeReport({ rows: [row({ reentry_until: '2027-03-15T18:30:00Z', notes: 'Gate "B", dog inside' })] });
    const csv = detailCsv(report, 'UTC');
    const [head, line] = csv.split('\r\n');
    expect(head.startsWith('Date,Time,Applicator,Licence type,Licence number,Site address,Product,EPA reg. no.')).toBe(true);
    expect(line).toContain('2027-03-15,14:30,Sam Rivera,pesticide_applicator,PA-1001,"12 Oak St, Springfield",Talstar P,279-3206,No,2,fl oz,1000');
    expect(line).toContain('Ants; Spiders');
    expect(line).toContain('2027-03-15 18:30');
    expect(line).toContain('"Gate ""B"", dog inside"');
    expect(csv.split('\r\n')).toHaveLength(2);
  });
  it('product summary never merges units', () => {
    const report = normalizeReport({
      by_product: [
        { product_name: 'Talstar P', amount_unit: 'fl_oz', applications: 3, total_amount: 6, total_area_sqft: 3000, jobs: 2, first_at: '2027-03-01T10:00:00Z', last_at: '2027-03-20T10:00:00Z' },
        { product_name: 'Talstar P', amount_unit: 'gal', applications: 1, total_amount: 0.5, total_area_sqft: 0, jobs: 1 },
      ],
    });
    const lines = productSummaryCsv(report, 'UTC').split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('fl oz');
    expect(lines[2]).toContain('gal');
  });
});

describe('misc formatting', () => {
  it('formatAmount scales precision and tolerates non-finite input', () => {
    expect(formatAmount(1234.567)).toBe('1,235');
    expect(formatAmount(12.34)).toBe('12.3');
    expect(formatAmount(1.234)).toBe('1.23');
    expect(formatAmount(0.12345)).toBe('0.123');
    expect(formatAmount(Number.NaN)).toBe('—');
  });
  it('reportFileName uses the inclusive last day', () => {
    const p = resolvePeriod('last_quarter', new Date(2027, 4, 20));
    if ('error' in p) throw new Error('unexpected');
    expect(reportFileName('detail', p.from, p.to)).toBe('pesticide-usage-detail-2027-01-01_to_2027-03-31.csv');
    expect(reportFileName('products', 'bad', 'bad')).toBe('pesticide-usage-products-report.csv');
  });
});
