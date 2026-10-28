import { describe, it, expect } from 'vitest';
import {
  PAYROLL_PROVIDERS,
  PROVIDER_META,
  batchId,
  buildGustoAuthorizeUrl,
  buildGustoTokenRequest,
  chunk,
  classifyGustoStatus,
  csvText,
  defaultSettings,
  formatAmount,
  formatHours,
  gustoBaseFor,
  gustoErrorMessage,
  isAllowedGustoBase,
  matchGustoEmployees,
  normalizeLine,
  parseGustoCompanies,
  parseGustoEmployees,
  parseGustoTokens,
  pickGustoPayroll,
  planGustoUpdates,
  renderExportFile,
  sha256Hex,
  totalsOf,
  validateExternalId,
  validateSettings,
  type ExportLine,
} from '../../supabase/functions/_shared/payroll-connectors/engine';

const U1 = '3f9c1a2e-1111-4222-8333-444455556666';
const U2 = '3f9c1a2e-2222-4222-8333-444455556666';
const J1 = '3f9c1a2e-9999-4222-8333-444455556666';

const line = (over: Partial<ExportLine> = {}): ExportLine => ({
  employee_id: 'e1',
  employee_name: 'Ann Tech',
  external_id: '1001',
  external_job_id: null,
  regular_hours: 48,
  overtime_hours: 2.5,
  commission_cents: 10000,
  tip_cents: 1500,
  ...over,
});

const ctx = (provider: (typeof PAYROLL_PROVIDERS)[number]) => ({
  provider,
  settings: defaultSettings(provider),
  periodStart: '2027-12-01',
  periodEnd: '2027-12-15',
});

describe('number + csv helpers', () => {
  it('formats cents with integer math', () => {
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(5)).toBe('0.05');
    expect(formatAmount(123456)).toBe('1234.56');
    expect(formatAmount(-250)).toBe('-2.50');
  });
  it('rounds hours half-up at the requested precision', () => {
    expect(formatHours(7.333, 2)).toBe('7.33');
    expect(formatHours(7.335, 2)).toBe('7.34');
    expect(formatHours(40, 3)).toBe('40.000');
    expect(formatHours(0.0004, 3)).toBe('0.000');
  });
  it('blocks spreadsheet formula injection in text cells and quotes correctly', () => {
    expect(csvText('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvText('+1')).toBe("'+1");
    expect(csvText('-cmd')).toBe("'-cmd");
    expect(csvText('@SUM')).toBe("'@SUM");
    expect(csvText('Smith, Ann')).toBe('"Smith, Ann"');
    expect(csvText('plain')).toBe('plain');
  });
  it('normalises numeric strings coming back from PostgREST', () => {
    const l = normalizeLine({ employee_id: 'e', employee_name: 'A', external_id: '9', regular_hours: '12.500', overtime_hours: null, commission_cents: '1000', tip_cents: 0 });
    expect(l.regular_hours).toBe(12.5);
    expect(l.overtime_hours).toBe(0);
    expect(l.commission_cents).toBe(1000);
  });
  it('builds an ADP batch id from prefix + period end', () => {
    expect(batchId('VRK', '2027-12-15')).toBe('VRK1215');
    expect(batchId('', '2027-01-03')).toBe('VRK0103');
  });
});

describe('settings validation (mirrors SQL)', () => {
  it('accepts defaults and trims', () => {
    const r = validateSettings('adp', { adp: { co_code: ' AB1 ' }, earnings: { commission: 'COM', tips: 'TIP' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings.adp.co_code).toBe('AB1');
      expect(r.settings.earnings.tips).toBe('TIP');
    }
  });
  it('rejects unknown keys, formula-looking names and bad ADP codes', () => {
    expect(validateSettings('adp', { evil: {} }).ok).toBe(false);
    expect(validateSettings('adp', { earnings: { tips: '=cmd|calc' } }).ok).toBe(false);
    expect(validateSettings('adp', { adp: { co_code: 'TOOLONGCODE' } }).ok).toBe(false);
    expect(validateSettings('adp', { earnings: { bonus: 'X' } }).ok).toBe(false);
    expect(validateSettings('adp', [] as unknown).ok).toBe(false);
  });
  it('pins Gusto earning names', () => {
    const r = validateSettings('gusto', { earnings: { tips: 'Whatever' } });
    expect(r.ok && r.settings.earnings.tips).toBe('Paycheck Tips');
  });
  it('validates provider ids', () => {
    expect(validateExternalId('adp', ' 1042 ')).toEqual({ ok: true, value: '1042' });
    expect(validateExternalId('adp', '=BAD').ok).toBe(false);
    expect(validateExternalId('gusto', 'not-a-uuid').ok).toBe(false);
    expect(validateExternalId('gusto', U1).ok).toBe(true);
    expect(validateExternalId('rippling', '').ok).toBe(true);
  });
  it('has complete metadata for every provider', () => {
    for (const p of PAYROLL_PROVIDERS) {
      expect(PROVIDER_META[p].label.length).toBeGreaterThan(2);
      expect(PROVIDER_META[p].setup.length).toBeGreaterThan(1);
    }
    expect(PROVIDER_META.gusto.supportsApi).toBe(true);
    expect(PROVIDER_META.adp.supportsApi).toBe(false);
  });
});

describe('file renderers', () => {
  it('renders the ADP wide layout, one row per employee, 2-decimal hours', () => {
    const s = defaultSettings('adp');
    s.adp.co_code = 'AB1';
    const f = renderExportFile([line({ regular_hours: 7.333 }), line({ employee_id: 'e2', external_id: '1002', employee_name: 'Bob', regular_hours: 0, overtime_hours: 0, commission_cents: 0, tip_cents: 900 })], { ...ctx('adp'), settings: s });
    const rows = f.content.replace('﻿', '').trim().split('\r\n');
    expect(rows[0]).toBe('Co Code,Batch ID,File #,Reg Hours,O/T Hours,Earnings 3 Code,Earnings 3 Amount,Earnings 4 Code,Earnings 4 Amount');
    expect(rows[1]).toBe('AB1,VRK1215,1001,7.33,2.50,COM,100.00,TIP,15.00');
    expect(rows[2]).toBe('AB1,VRK1215,1002,,,,,TIP,9.00');
    expect(f.rowCount).toBe(2);
    expect(f.content.startsWith('﻿')).toBe(true);
    expect(f.fileName).toBe('vireek-adp-payroll-2027-12-01_2027-12-15.csv');
  });
  it('renders the long layout with one row per earning and skips zero earnings', () => {
    const f = renderExportFile([line({ regular_hours: 0, overtime_hours: 0 })], ctx('paychex'));
    const rows = f.content.replace('﻿', '').trim().split('\r\n');
    expect(rows[0]).toBe('Worker ID,Employee Name,Earning,Hours,Amount,Pay Period Start,Pay Period End');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toBe('1001,Ann Tech,Commission,,100.00,2027-12-01,2027-12-15');
    expect(rows[2]).toBe('1001,Ann Tech,Paycheck Tips,,15.00,2027-12-01,2027-12-15');
  });
  it('uses 3-decimal hours for Gusto and the provider id header', () => {
    const f = renderExportFile([line({ external_id: U1 })], ctx('gusto'));
    const rows = f.content.replace('﻿', '').trim().split('\r\n');
    expect(rows[0].startsWith('Employee UUID,')).toBe(true);
    expect(rows[1]).toContain(',Regular Hours,48.000,,');
    expect(rows[2]).toContain(',Overtime,2.500,,');
  });
  it('never lets an employee name inject a formula', () => {
    const f = renderExportFile([line({ employee_name: '=1+1' })], ctx('rippling'));
    expect(f.content).toContain("'=1+1");
    expect(f.content).not.toMatch(/,=1\+1,/);
  });
  it('is deterministic and checksum-stable', async () => {
    const a = renderExportFile([line()], ctx('rippling'));
    const b = renderExportFile([line()], ctx('rippling'));
    expect(await sha256Hex(a.content)).toBe(await sha256Hex(b.content));
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('sums totals exactly', () => {
    const t = totalsOf([line(), line({ employee_id: 'e2', regular_hours: 7.333, overtime_hours: 0.1, commission_cents: 1, tip_cents: 2 })]);
    expect(t).toEqual({ employees: 2, regular_hours: 55.333, overtime_hours: 2.6, commission_cents: 10001, tip_cents: 1502 });
  });
});

describe('Gusto OAuth + parsing', () => {
  it('builds authorize and token requests against allow-listed hosts only', () => {
    const url = buildGustoAuthorizeUrl({ base: gustoBaseFor('sandbox'), clientId: 'cid', redirectUri: 'https://x.test/cb', state: 's.t' });
    expect(url.startsWith('https://api.gusto-demo.com/oauth/authorize?')).toBe(true);
    expect(url).toContain('response_type=code');
    const req = buildGustoTokenRequest('refresh', { base: gustoBaseFor('production'), clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    expect(req.url).toBe('https://api.gusto.com/oauth/token');
    expect(req.body).toContain('grant_type=refresh_token');
    expect(isAllowedGustoBase('https://api.gusto.com/')).toBe(true);
    expect(isAllowedGustoBase('https://evil.example.com')).toBe(false);
  });
  it('parses tokens and rejects a response without an access token', () => {
    expect(parseGustoTokens({ access_token: 'a', refresh_token: 'r', expires_in: 7200 })).toEqual({ accessToken: 'a', refreshToken: 'r', expiresInSec: 7200 });
    expect(() => parseGustoTokens({})).toThrow();
  });
  it('reads companies from /me and ignores malformed ids', () => {
    const c = parseGustoCompanies({ roles: { payroll_admin: { companies: [{ uuid: U1, name: 'Acme HVAC' }, { uuid: 'bad' }] } } });
    expect(c).toEqual([{ id: U1, name: 'Acme HVAC' }]);
    expect(parseGustoCompanies(null)).toEqual([]);
  });
  it('reads employees, primary job and terminated flag', () => {
    const e = parseGustoEmployees([{ uuid: U1, first_name: 'Ann', last_name: 'Tech', email: 'ANN@x.com', jobs: [{ uuid: 'j0' }, { uuid: J1, primary: true }] }, { uuid: U2, first_name: 'Old', terminated: true }]);
    expect(e[0]).toMatchObject({ id: U1, name: 'Ann Tech', email: 'ann@x.com', jobId: J1, terminated: false });
    expect(e[1].terminated).toBe(true);
  });
  it('classifies statuses and extracts error messages', () => {
    expect(classifyGustoStatus(200)).toBe('ok');
    expect(classifyGustoStatus(409)).toBe('conflict');
    expect(classifyGustoStatus(422)).toBe('invalid');
    expect(classifyGustoStatus(401)).toBe('auth');
    expect(classifyGustoStatus(429)).toBe('throttle');
    expect(gustoErrorMessage({ errors: [{ message: 'Hours too high' }] }, 'x')).toBe('Hours too high');
    expect(gustoErrorMessage(null, 'fallback')).toBe('fallback');
  });
  it('chunks into groups of at most N', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('Gusto employee auto-match', () => {
  const g = parseGustoEmployees([
    { uuid: U1, first_name: 'Ann', last_name: 'Tech', email: 'ann@x.com', jobs: [{ uuid: J1, primary: true }] },
    { uuid: U2, first_name: 'Bob', last_name: 'Hourly', email: 'bob@other.com' },
  ]);
  it('matches by email first, then by unique name, one-to-one', () => {
    const out = matchGustoEmployees(
      [
        { employee_id: 'e1', name: 'Annie T', email: 'ANN@x.com', external_id: null },
        { employee_id: 'e2', name: 'bob  hourly', email: null, external_id: null },
      ],
      g,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ employee_id: 'e1', external_id: U1, external_job_id: J1, match_source: 'email' });
    expect(out[1]).toMatchObject({ employee_id: 'e2', external_id: U2, match_source: 'name' });
  });
  it('never guesses ambiguous names and skips already-linked employees', () => {
    const out = matchGustoEmployees(
      [
        { employee_id: 'e1', name: 'Bob Hourly', email: null, external_id: null },
        { employee_id: 'e2', name: 'Bob Hourly', email: null, external_id: null },
        { employee_id: 'e3', name: 'Ann Tech', email: null, external_id: U1 },
      ],
      g,
    );
    expect(out).toEqual([]);
  });
});

describe('Gusto delivery planning', () => {
  const payrolls = [
    { payroll_uuid: 'p0', pay_period: { start_date: '2027-11-01', end_date: '2027-11-15' }, processed: false },
    { payroll_uuid: 'p1', pay_period: { start_date: '2027-12-01', end_date: '2027-12-15' }, processed: false },
    { payroll_uuid: 'p2', pay_period: { start_date: '2027-12-01', end_date: '2027-12-15' }, processed: true },
  ];
  it('picks only the unprocessed payroll with exactly the export dates', () => {
    expect(pickGustoPayroll(payrolls, '2027-12-01', '2027-12-15')?.id).toBe('p1');
    expect(pickGustoPayroll(payrolls, '2027-12-02', '2027-12-15')).toBeNull();
    expect(pickGustoPayroll(null, 'a', 'b')).toBeNull();
  });

  const comps = [
    { employee_uuid: U1, version: 'v1', hourly_compensations: [{ name: 'Regular Hours', hours: '0.000' }], fixed_compensations: [] },
    { employee_uuid: U2, version: 'v2', hourly_compensations: [{ name: 'Regular Hours', hours: '30.000' }], fixed_compensations: [{ name: 'Commission', amount: '50.00' }] },
  ];

  it('sets values (not adds) and only sends what changed, with the per-employee version', () => {
    const { updates, outcomes } = planGustoUpdates([line({ external_id: U1, external_job_id: J1 })], comps, { overwrite: false });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      employee_uuid: U1,
      version: 'v1',
      fixed_compensations: [
        { name: 'Commission', amount: '100.00', job_uuid: J1 },
        { name: 'Paycheck Tips', amount: '15.00', job_uuid: J1 },
      ],
      hourly_compensations: [
        { name: 'Regular Hours', hours: '48.000', job_uuid: J1 },
        { name: 'Overtime', hours: '2.500', job_uuid: J1 },
      ],
    });
    expect(outcomes.get('e1')?.status).toBe('pending');
  });
  it('is idempotent: values Gusto already holds become "unchanged"', () => {
    const same = [{ employee_uuid: U1, version: 'v9', hourly_compensations: [{ name: 'Regular Hours', hours: '48.000' }, { name: 'Overtime', hours: '2.500' }], fixed_compensations: [{ name: 'Commission', amount: '100.00' }, { name: 'Paycheck Tips', amount: '15.00' }] }];
    const { updates, outcomes } = planGustoUpdates([line({ external_id: U1 })], same, { overwrite: false });
    expect(updates).toEqual([]);
    expect(outcomes.get('e1')?.status).toBe('unchanged');
  });
  it('protects existing different values unless overwrite is on, all-or-nothing per employee', () => {
    const l = line({ employee_id: 'e2', external_id: U2, regular_hours: 40, overtime_hours: 0, commission_cents: 7500, tip_cents: 0 });
    const guarded = planGustoUpdates([l], comps, { overwrite: false });
    expect(guarded.updates).toEqual([]);
    expect(guarded.outcomes.get('e2')?.status).toBe('conflict');
    expect(guarded.outcomes.get('e2')?.message).toContain('Overwrite');
    const forced = planGustoUpdates([l], comps, { overwrite: true });
    expect(forced.updates).toHaveLength(1);
    expect(forced.updates[0].hourly_compensations?.[0].hours).toBe('40.000');
    expect(forced.updates[0].fixed_compensations?.[0].amount).toBe('75.00');
  });
  it('reports employees that are not on the payroll', () => {
    const { updates, outcomes } = planGustoUpdates([line({ external_id: '3f9c1a2e-0000-4222-8333-444455556666' })], comps, { overwrite: false });
    expect(updates).toEqual([]);
    expect(outcomes.get('e1')?.status).toBe('error');
  });
});
