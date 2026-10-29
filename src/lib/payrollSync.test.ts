// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  BATCH_ACTIONS,
  ProviderError,
  canBatchTransition,
  canSendBatch,
  centsToAmount,
  hoursToString,
  normalizeSettings,
  runSync,
  signPayrollState,
  suggestLinks,
  verifyPayrollState,
  type ClaimedBatch,
  type ClaimedLine,
  type LineOutcome,
  type SyncStore,
} from '../../supabase/functions/_shared/payroll/engine';
import {
  buildGustoAuthorizeUrl,
  buildGustoTokenRequest,
  createGustoAdapter,
  mergeCompensation,
  parseGustoMe,
  parseGustoToken,
  type GustoEmpComp,
} from '../../supabase/functions/_shared/payroll/gusto';

const settings = normalizeSettings({});
const line = (o: Partial<ClaimedLine> = {}): ClaimedLine => ({
  line_id: 'l1', employee_id: 'e1', employee_name: 'Ann Hourly', external_employee_id: 'g-ann',
  regular_hours: 16, overtime_hours: 2.5, commission_cents: 5000, send_hours: true, line_hash: 'h', ...o,
});
const comp = (id: string, extra: Partial<GustoEmpComp> = {}): GustoEmpComp => ({
  employee_uuid: id, fixed_compensations: [], hourly_compensations: [{ name: 'Regular Hours', hours: '0.000', job_uuid: 'job-1' }], ...extra,
});
const claimed = (lines: ClaimedLine[], period = { s: '2028-01-01', e: '2028-01-15' }): ClaimedBatch => ({
  batch: { id: 'b1', provider: 'gusto', period_start: period.s, period_end: period.e, external_payroll_id: null, connection_id: 'c1' },
  settings, external_company_id: 'co-1', environment: 'sandbox', lines,
});

// ---------- mock Gusto ----------
interface MockOpts { processed?: boolean; period?: [string, string]; ignorePut?: boolean; rejectIf?: (c: GustoEmpComp) => boolean; extraPayroll?: boolean; unprepared?: boolean }
function mockGusto(initial: GustoEmpComp[], opts: MockOpts = {}) {
  const state = {
    version: 1, comps: initial.map((c) => structuredClone(c)), calls: [] as string[], puts: 0, token401: 0, rate429: 0, prepared: !opts.unprepared,
  };
  const payrollJson = () => ({
    payroll_uuid: 'p1', version: `v${state.version}`, processed: opts.processed === true, check_date: '2028-01-20',
    pay_period: { start_date: (opts.period ?? ['2028-01-01', '2028-01-15'])[0], end_date: (opts.period ?? ['2028-01-01', '2028-01-15'])[1] },
    employee_compensations: state.prepared ? state.comps : [],
  });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    state.calls.push(`${method} ${url.pathname}`);
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (state.token401 > 0 && auth === 'Bearer old') { state.token401--; return json({ error: 'expired' }, 401); }
    if (state.rate429 > 0) { state.rate429--; return json({}, 429, { 'retry-after': '0' }); }
    if (url.pathname.endsWith('/employees')) {
      return json([
        { uuid: 'g-ann', first_name: 'Ann', last_name: 'Hourly', terminated: false },
        { uuid: 'g-old', first_name: 'Old', last_name: 'Timer', terminated: true },
      ]);
    }
    if (url.pathname.endsWith('/payrolls') && method === 'GET') {
      const rows = [payrollJson()];
      if (opts.extraPayroll) rows.push({ ...payrollJson(), payroll_uuid: 'p2' } as ReturnType<typeof payrollJson>);
      return json(rows);
    }
    if (url.pathname.endsWith('/prepare')) { state.prepared = true; return json(payrollJson()); }
    if (url.pathname.endsWith('/payrolls/p1') && method === 'GET') return json(payrollJson());
    if (url.pathname.endsWith('/payrolls/p1') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { employee_compensations: GustoEmpComp[] };
      if (body.employee_compensations.some((c) => opts.rejectIf?.(c))) return json({ errors: [{ message: 'Hourly compensation is invalid for this employee.' }] }, 422);
      state.puts++;
      if (!opts.ignorePut) {
        for (const c of body.employee_compensations) {
          const i = state.comps.findIndex((x) => x.employee_uuid === c.employee_uuid);
          if (i >= 0) state.comps[i] = { ...state.comps[i], fixed_compensations: c.fixed_compensations, hourly_compensations: c.hourly_compensations };
        }
        state.version++;
      }
      return json(payrollJson());
    }
    return json({ error: 'not found' }, 404);
  };
  const adapter = (over: Partial<Parameters<typeof createGustoAdapter>[0]> = {}) =>
    createGustoAdapter({ fetch: fetchImpl, baseUrl: 'https://api.gusto-demo.com', companyId: 'co-1', getAccessToken: async () => 'tok', refreshAccessToken: async () => 'fresh', sleep: async () => {}, ...over });
  return { state, adapter };
}

function memoryStore(): SyncStore & { outcomes: LineOutcome[]; finished: { error: string | null; payroll: string | null } | null } {
  const s = {
    outcomes: [] as LineOutcome[], finished: null as { error: string | null; payroll: string | null } | null,
    async record(o: LineOutcome) { s.outcomes.push(o); },
    async finish(error: string | null, payroll: string | null) {
      s.finished = { error, payroll };
      const done = s.outcomes.filter((o) => o.status !== 'failed').length;
      const open = s.outcomes.filter((o) => o.status === 'failed').length;
      return open === 0 && done > 0 ? 'synced' : done > 0 ? 'partial' : 'failed';
    },
  };
  return s;
}

describe('mergeCompensation', () => {
  it('sets regular, adds overtime on the same job, adds commission and keeps unrelated rows', () => {
    const existing = comp('g-ann', { fixed_compensations: [{ name: 'Bonus', amount: '10.00' }] });
    const r = mergeCompensation(existing, line(), settings);
    expect(r.ok && r.changed).toBe(true);
    if (!r.ok) return;
    expect(r.next.hourly_compensations).toEqual([
      { name: 'Regular Hours', hours: '16.000', job_uuid: 'job-1' },
      { name: 'Overtime', hours: '2.500', job_uuid: 'job-1' },
    ]);
    expect(r.next.fixed_compensations).toEqual([{ name: 'Bonus', amount: '10.00' }, { name: 'Commission', amount: '50.00' }]);
  });
  it('is idempotent: merging the result again changes nothing', () => {
    const first = mergeCompensation(comp('g-ann'), line(), settings);
    if (!first.ok) throw new Error('expected ok');
    const second = mergeCompensation(first.next, line(), settings);
    expect(second.ok && second.changed).toBe(false);
  });
  it('never sends hours for salaried lines but still sends commission', () => {
    const r = mergeCompensation(comp('g-bob'), line({ send_hours: false, regular_hours: 0, overtime_hours: 0, commission_cents: 12000 }), settings);
    if (!r.ok) throw new Error('expected ok');
    expect(r.next.hourly_compensations[0].hours).toBe('0.000');
    expect(r.next.fixed_compensations).toEqual([{ name: 'Commission', amount: '120.00' }]);
  });
  it('refuses excluded employees and employees without an hourly pay line', () => {
    expect(mergeCompensation(comp('g-ann', { excluded: true }), line(), settings)).toMatchObject({ ok: false, code: 'employee_excluded' });
    expect(mergeCompensation(comp('g-ann', { hourly_compensations: [] }), line(), settings)).toMatchObject({ ok: false, code: 'no_hourly_compensation' });
  });
  it('honours custom earning names', () => {
    const s = normalizeSettings({ regular_name: 'Hourly', overtime_name: 'OT 1.5x', commission_name: 'Sales Commission' });
    const r = mergeCompensation(comp('g-ann', { hourly_compensations: [{ name: 'hourly', hours: '0', job_uuid: 'j' }] }), line(), s);
    if (!r.ok) throw new Error('expected ok');
    expect(r.next.hourly_compensations.map((h) => h.name)).toEqual(['hourly', 'OT 1.5x']);
    expect(r.next.fixed_compensations[0].name).toBe('Sales Commission');
  });
});

describe('Gusto adapter + runSync (mock provider)', () => {
  it('sends a batch once, then a re-send is a no-op (idempotent)', async () => {
    const g = mockGusto([comp('g-ann')]);
    const first = memoryStore();
    const r1 = await runSync(claimed([line()]), g.adapter(), first, null);
    expect(r1.status).toBe('synced');
    expect(first.outcomes[0]).toMatchObject({ status: 'sent', external_ref: 'p1' });
    expect(g.state.puts).toBe(1);

    const second = memoryStore();
    const r2 = await runSync(claimed([line()]), g.adapter(), second, null);
    expect(r2.status).toBe('synced');
    expect(second.outcomes[0].status).toBe('unchanged');
    expect(g.state.puts).toBe(1); // no second write
    expect(g.state.calls.some((c) => c.includes('/calculate') || c.includes('/submit'))).toBe(false);
  });

  it('marks employees missing from the open payroll as failed without blocking others', async () => {
    const g = mockGusto([comp('g-ann')]);
    const store = memoryStore();
    const r = await runSync(claimed([line(), line({ line_id: 'l2', external_employee_id: 'g-ghost', employee_name: 'Ghost' })]), g.adapter(), store, null);
    expect(r.status).toBe('partial');
    expect(store.outcomes.find((o) => o.line_id === 'l2')).toMatchObject({ status: 'failed', error_code: 'employee_not_on_payroll' });
    expect(store.outcomes.find((o) => o.line_id === 'l1')?.status).toBe('sent');
  });

  it('falls back to one-by-one when the combined update is rejected, isolating the bad line', async () => {
    const g = mockGusto([comp('g-ann'), comp('g-bad')], { rejectIf: (c) => c.employee_uuid === 'g-bad' });
    const store = memoryStore();
    const r = await runSync(claimed([line(), line({ line_id: 'l2', external_employee_id: 'g-bad', employee_name: 'Bad' })]), g.adapter(), store, null);
    expect(r.status).toBe('partial');
    expect(store.outcomes.find((o) => o.line_id === 'l1')?.status).toBe('sent');
    expect(store.outcomes.find((o) => o.line_id === 'l2')).toMatchObject({ status: 'failed', error_code: 'validation' });
  });

  it('catches a provider that accepts the write but does not store it', async () => {
    const g = mockGusto([comp('g-ann')], { ignorePut: true });
    const store = memoryStore();
    const r = await runSync(claimed([line()]), g.adapter(), store, null);
    expect(r.status).toBe('failed');
    expect(store.outcomes[0]).toMatchObject({ status: 'failed', error_code: 'verification_failed' });
  });

  it('refreshes an expired token once and retries rate limits', async () => {
    const g = mockGusto([comp('g-ann')]);
    g.state.token401 = 1;
    g.state.rate429 = 1;
    let refreshes = 0;
    const store = memoryStore();
    const r = await runSync(claimed([line()]), g.adapter({ getAccessToken: async () => 'old', refreshAccessToken: async () => { refreshes++; return 'fresh'; } }), store, null);
    expect(refreshes).toBe(1);
    expect(r.status).toBe('synced');
  });

  it('prepares an unprepared payroll before reading pay lines', async () => {
    const g = mockGusto([comp('g-ann')], { unprepared: true });
    const r = await runSync(claimed([line()]), g.adapter(), memoryStore(), null);
    expect(r.status).toBe('synced');
    expect(g.state.calls).toContain('PUT /v1/companies/co-1/payrolls/p1/prepare');
  });

  it('fails every line with a clear code when the provider payroll is processed, missing or ambiguous', async () => {
    const processed = memoryStore();
    await runSync(claimed([line()]), mockGusto([comp('g-ann')], { processed: true }).adapter(), processed, 'p1');
    expect(processed.outcomes[0]).toMatchObject({ status: 'failed', error_code: 'payroll_processed' });

    const wrongPeriod = memoryStore();
    await runSync(claimed([line()], { s: '2028-02-01', e: '2028-02-15' }), mockGusto([comp('g-ann')]).adapter(), wrongPeriod, null);
    expect(wrongPeriod.outcomes[0].error_code).toBe('no_matching_payroll');

    const ambiguous = memoryStore();
    await runSync(claimed([line()]), mockGusto([comp('g-ann')], { extraPayroll: true }).adapter(), ambiguous, null);
    expect(ambiguous.outcomes[0].error_code).toBe('ambiguous_payroll');
    expect(ambiguous.finished?.error).toContain('More than one open payroll');
  });

  it('lists employees and open payrolls', async () => {
    const a = mockGusto([comp('g-ann')]).adapter();
    expect((await a.listEmployees()).map((e) => [e.id, e.terminated])).toEqual([['g-ann', false], ['g-old', true]]);
    expect((await a.listOpenPayrolls('2028-01-01', '2028-01-15'))[0]).toMatchObject({ id: 'p1', start: '2028-01-01' });
  });

  it('turns an unexpected throw into failed lines (nothing stays "pending")', async () => {
    const store = memoryStore();
    const adapter = { resolvePayroll: async () => { throw new Error('boom'); }, pushLines: async () => [] };
    const r = await runSync(claimed([line()]), adapter, store, null);
    expect(r.status).toBe('failed');
    expect(store.outcomes[0]).toMatchObject({ status: 'failed', error_code: 'unexpected' });
    expect(new ProviderError('network').message).toContain('could not reach');
  });
});

describe('suggestLinks', () => {
  const ext = (id: string, name: string, terminated = false) => ({ id, name, email: null, terminated });
  it('suggests only unambiguous exact name matches and never terminated or already-linked people', () => {
    const out = suggestLinks(
      [{ id: 'e1', full_name: 'Ann Hourly' }, { id: 'e2', full_name: 'José Pérez' }, { id: 'e3', full_name: 'Sam Lee' }, { id: 'e4', full_name: 'Sam Lee' }, { id: 'e5', full_name: 'Old Timer' }, { id: 'e6', full_name: 'Linked Person' }],
      [ext('x1', 'Hourly, Ann'), ext('x2', 'Jose Perez'), ext('x3', 'Sam Lee'), ext('x4', 'Old Timer', true), ext('x5', 'Linked Person')],
      new Set(['e6']), new Set(),
    );
    expect(out.map((s) => [s.employee_id, s.external_id])).toEqual([['e1', 'x1'], ['e2', 'x2']]);
  });
  it('skips a provider name that appears twice', () => {
    expect(suggestLinks([{ id: 'e1', full_name: 'Ann Hourly' }], [ext('x1', 'Ann Hourly'), ext('x2', 'Ann  Hourly')], new Set(), new Set())).toEqual([]);
  });
});

describe('OAuth state + request shapes', () => {
  it('round-trips, rejects tampering, wrong secrets and expired state', async () => {
    const t = 1_000_000;
    const s = await signPayrollState({ owner: 'o', user: 'u', provider: 'gusto' }, 'secret', t);
    expect(await verifyPayrollState(s, 'secret', t + 1000)).toMatchObject({ o: 'o', u: 'u', p: 'gusto' });
    expect(await verifyPayrollState(s, 'other', t + 1000)).toBeNull();
    expect(await verifyPayrollState(`${s}x`, 'secret', t + 1000)).toBeNull();
    expect(await verifyPayrollState(s, 'secret', t + 11 * 60_000)).toBeNull();
    expect(await verifyPayrollState('junk', 'secret', t)).toBeNull();
  });
  it('builds Gusto URLs and parses tokens / company', () => {
    expect(buildGustoAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's', environment: 'sandbox' })).toContain('https://api.gusto-demo.com/oauth/authorize?client_id=cid');
    const req = buildGustoTokenRequest('refresh', { environment: 'production', clientId: 'a', clientSecret: 'b', redirectUri: 'https://x/cb', refreshToken: 'r' });
    expect(req.url).toBe('https://api.gusto.com/oauth/token');
    expect(req.body).toContain('grant_type=refresh_token');
    expect(parseGustoToken({ access_token: 'a', refresh_token: 'r', expires_in: 7200 })).toEqual({ accessToken: 'a', refreshToken: 'r', expiresInSec: 7200 });
    expect(() => parseGustoToken({})).toThrow();
    expect(parseGustoMe({ roles: { payroll_admin: { companies: [{ uuid: 'c1', name: 'Acme HVAC' }] } } })).toEqual({ companyId: 'c1', companyName: 'Acme HVAC' });
    expect(parseGustoMe({ roles: {} })).toBeNull();
  });
});

describe('formatting, settings and status machine', () => {
  it('formats money and hours', () => {
    expect(centsToAmount(5000)).toBe('50.00');
    expect(hoursToString(2.5)).toBe('2.500');
  });
  it('normalises settings', () => {
    expect(normalizeSettings({ regular_name: '  ', commission_name: 'X'.repeat(80), require_separate_approver: 'yes' })).toEqual({
      regular_name: 'Regular Hours', overtime_name: 'Overtime', commission_name: 'X'.repeat(60), require_separate_approver: false,
    });
  });
  it('only allows the documented transitions', () => {
    expect(canBatchTransition('draft', 'submit')).toBe(true);
    expect(canBatchTransition('draft', 'approve')).toBe(false);
    expect(canBatchTransition('synced', 'cancel')).toBe(false);
    expect(canBatchTransition('approved', 'cancel')).toBe(true);
    expect(BATCH_ACTIONS.syncing).toEqual([]);
    expect(['approved', 'partial', 'failed'].every((s) => canSendBatch(s as never))).toBe(true);
    expect(canSendBatch('draft')).toBe(false);
  });
});
