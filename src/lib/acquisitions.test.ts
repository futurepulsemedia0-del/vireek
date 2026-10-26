import { describe, it, expect } from 'vitest';
import {
  addDays, buildBaselineMetrics, canMoveTo, checkSummary, currentPhase, dayNumber, dueState, evaluateControl, formatCents, formatKpi,
  groupByPhase, integrationHealth, isIsoDate, kpiDelta, latestRun, monthsBetweenInclusive, normalizeAcquisition, normalizeKpis,
  normalizePortfolio, normalizeWorkstream, openDependencies, parseMoneyToCents, planToDate, portfolioTotals, progress, readyToStart,
  retentionRisk, synergyRollup, validateActual, validateControl, validateNewAcquisition, validateSynergy, wouldCreateCycle,
  EMPTY_DRAFT, type DataCheck, type Dep, type PortfolioRow, type Synergy, type SynergyActual, type Workstream,
} from './acquisitions';

const TODAY = '2027-03-15';
const ws = (id: string, over: Partial<Workstream> = {}): Workstream => ({
  id, acquisition_id: 'a1', kind: 'custom', title: `WS ${id}`, description: null, phase: 'day_30', owner_member_id: null, owner_label: null,
  due_date: '2027-03-20', status: 'not_started', sort_order: 0, notes: null, completed_at: null, ...over,
});

describe('dates', () => {
  it('validates calendar days strictly', () => {
    expect(isIsoDate('2027-02-28')).toBe(true);
    expect(isIsoDate('2027-02-30')).toBe(false);
    expect(isIsoDate('2027-2-3')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
  it('adds days across month and year boundaries without timezone drift', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
  it('numbers integration days and phases', () => {
    expect(dayNumber('2027-03-01', TODAY)).toBe(14);
    expect(dayNumber('2027-03-20', TODAY)).toBe(-5);
    expect(currentPhase(-1)).toBe('pre');
    expect(currentPhase(0)).toBe('day_30');
    expect(currentPhase(30)).toBe('day_30');
    expect(currentPhase(31)).toBe('day_60');
    expect(currentPhase(61)).toBe('day_90');
    expect(currentPhase(91)).toBe('post');
  });
  it('counts months inclusively like the SQL plan-to-date', () => {
    expect(monthsBetweenInclusive('2027-01-15', '2027-01-31')).toBe(1);
    expect(monthsBetweenInclusive('2026-11-01', '2027-03-15')).toBe(5);
    expect(monthsBetweenInclusive('2027-05-01', '2027-03-15')).toBe(0);
  });
});

describe('normalizers never trust a row', () => {
  it('drops malformed acquisitions and repairs unknown enums', () => {
    expect(normalizeAcquisition({ id: 'x', name: 'Acme', close_date: 'bad' })).toBeNull();
    const a = normalizeAcquisition({ id: 'x', name: 'Acme', close_date: '2027-01-02', status: 'weird', scope_kind: 'nope', purchase_price_cents: '125000' });
    expect(a?.status).toBe('integrating');
    expect(a?.scope_kind).toBe('external');
    expect(a?.purchase_price_cents).toBe(125000);
    expect(a?.target_jobs_per_tech_day).toBe(4);
  });
  it('normalizes workstreams and KPIs', () => {
    expect(normalizeWorkstream({ id: 'w', acquisition_id: 'a', title: 'T', kind: 'zzz', due_date: '2027-13-01' })?.kind).toBe('custom');
    expect(normalizeWorkstream({ id: 'w', acquisition_id: 'a', title: 'T', due_date: '2027-13-01' })?.due_date).toBeNull();
    expect(normalizeKpis(null)).toBeNull();
    expect(normalizeKpis({ revenue_cents: '5', gross_margin_pct: null })?.revenue_cents).toBe(5);
    expect(normalizeKpis({ gross_margin_pct: null })?.gross_margin_pct).toBeNull();
  });
  it('tolerates an empty or broken portfolio payload', () => {
    expect(normalizePortfolio(null)).toEqual({ parent: null, companies: [] });
    expect(normalizePortfolio({ companies: [{ id: 'a' }, 7] }).companies).toHaveLength(0);
  });
});

describe('workstream rules mirror the database', () => {
  const list = [ws('a', { status: 'done' }), ws('b'), ws('c')];
  const deps: Dep[] = [{ workstream_id: 'b', depends_on_id: 'a' }, { workstream_id: 'c', depends_on_id: 'b' }];
  it('blocks starting or finishing while a dependency is open', () => {
    expect(canMoveTo('in_progress', 'b', list, deps).ok).toBe(true);
    const r = canMoveTo('done', 'c', list, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('WS b');
    expect(canMoveTo('blocked', 'c', list, deps).ok).toBe(true);
    expect(canMoveTo('skipped', 'c', list, deps).ok).toBe(true);
  });
  it('treats skipped dependencies as cleared', () => {
    const l2 = [ws('a', { status: 'skipped' }), ws('b')];
    expect(openDependencies('b', l2, [{ workstream_id: 'b', depends_on_id: 'a' }])).toHaveLength(0);
  });
  it('detects dependency cycles', () => {
    expect(wouldCreateCycle('c', 'a', deps)).toBe(false);
    expect(wouldCreateCycle('a', 'c', deps)).toBe(true);
    expect(wouldCreateCycle('a', 'a', deps)).toBe(true);
    expect(wouldCreateCycle('a', 'c', [{ workstream_id: 'c', depends_on_id: 'b' }, { workstream_id: 'b', depends_on_id: 'a' }])).toBe(true);
  });
  it('classifies due state', () => {
    expect(dueState(ws('x', { due_date: '2027-03-10' }), TODAY)).toBe('overdue');
    expect(dueState(ws('x', { due_date: '2027-03-15' }), TODAY)).toBe('due_soon');
    expect(dueState(ws('x', { due_date: '2027-03-22' }), TODAY)).toBe('due_soon');
    expect(dueState(ws('x', { due_date: '2027-03-23' }), TODAY)).toBe('upcoming');
    expect(dueState(ws('x', { due_date: null }), TODAY)).toBe('no_date');
    expect(dueState(ws('x', { due_date: '2020-01-01', status: 'done' }), TODAY)).toBe('closed');
  });
  it('summarizes progress and picks what is ready', () => {
    const p = progress([ws('a', { status: 'done' }), ws('b', { due_date: '2027-03-01' }), ws('c', { status: 'blocked' })], TODAY);
    expect(p).toEqual({ total: 3, closed: 1, pct: 33, overdue: 1, blocked: 1, inProgress: 0 });
    expect(progress([], TODAY).pct).toBe(0);
    expect(readyToStart(list, deps).map((w) => w.id)).toEqual(['b']);
  });
  it('groups by phase in sort order', () => {
    const g = groupByPhase([ws('z', { phase: 'day_60', sort_order: 2 }), ws('y', { phase: 'day_60', sort_order: 1 }), ws('x')]);
    expect(g.day_60.map((w) => w.id)).toEqual(['y', 'z']);
    expect(g.day_90).toHaveLength(0);
  });
});

describe('data check bands match acq_run_data_checks', () => {
  it('passes within tolerance, warns within 2x (min 1%), fails beyond', () => {
    expect(evaluateControl(1000, 1000, 0).status).toBe('pass');
    expect(evaluateControl(1000, 995, 1).status).toBe('pass');
    expect(evaluateControl(1000, 992, 0).status).toBe('warn');
    expect(evaluateControl(1000, 900, 0).status).toBe('fail');
    expect(evaluateControl(0, 0, 0).status).toBe('pass');
    expect(evaluateControl(0, 5, 0).status).toBe('fail');
    expect(evaluateControl(1000, 1100, 5).diff).toBe(100);
  });
  it('keeps only the latest run and summarizes the verdict', () => {
    const c = (id: string, run: string, at: string, status: DataCheck['status']): DataCheck => ({ id, run_id: run, check_key: id, label: id, status, source_value: null, actual_value: null, diff: null, diff_pct: null, tolerance_pct: null, detail: null, checked_at: at });
    const rows = [c('1', 'r1', '2027-03-01T10:00:00Z', 'fail'), c('2', 'r2', '2027-03-02T10:00:00Z', 'pass'), c('3', 'r2', '2027-03-02T10:00:01Z', 'warn')];
    expect(latestRun(rows).map((r) => r.id)).toEqual(['2', '3']);
    expect(latestRun([])).toEqual([]);
    expect(checkSummary(latestRun(rows)).verdict).toBe('review');
    expect(checkSummary(rows).verdict).toBe('blocked');
    expect(checkSummary([]).verdict).toBe('none');
    expect(checkSummary([c('4', 'r', '2027-03-02T10:00:00Z', 'pass')]).verdict).toBe('clean');
  });
});

describe('KPIs and portfolio', () => {
  it('compares only rate KPIs, with the right tone', () => {
    expect(kpiDelta('gross_margin_pct', 40, 35)).toEqual({ diff: 5, label: '+5 pts', tone: 'good' });
    expect(kpiDelta('utilization_pct', 50, 70)?.tone).toBe('bad');
    expect(kpiDelta('avg_ticket_cents', 33000, 30000)?.label).toBe('+10%');
    expect(kpiDelta('revenue_cents', 5, 3)).toBeNull();
    expect(kpiDelta('gross_margin_pct', null, 3)).toBeNull();
    expect(kpiDelta('avg_ticket_cents', 5, 0)).toBeNull();
    expect(kpiDelta('retention_pct', 60, 60)?.tone).toBe('neutral');
  });
  it('rates retention risk', () => {
    expect(retentionRisk(null)).toBe('unknown');
    expect(retentionRisk(40)).toBe('high');
    expect(retentionRisk(60)).toBe('medium');
    expect(retentionRisk(70, 90)).toBe('medium');
    expect(retentionRisk(80, 82)).toBe('low');
  });
  const row = (over: Partial<PortfolioRow> = {}): PortfolioRow => ({
    id: 'a', name: 'A', status: 'integrating', close_date: '2027-01-01', scope_kind: 'imported', currency: 'USD', purchase_price_cents: null, has_live_data: true,
    kpis: { revenue_cents: 100000, gross_margin_pct: 40, utilization_pct: 60, retention_at_risk: 4 }, baseline: null, ws_total: 9, ws_done: 3, ws_overdue: 0, ws_blocked: 0,
    cost_plan_cents: 1000, cost_actual_cents: 800, rev_plan_cents: 500, rev_actual_cents: 600, ...over,
  });
  it('rates integration health', () => {
    expect(integrationHealth(row())).toBe('on_track');
    expect(integrationHealth(row({ ws_overdue: 1 }))).toBe('watch');
    expect(integrationHealth(row({ ws_blocked: 2 }))).toBe('at_risk');
    expect(integrationHealth(row({ ws_total: 0 }))).toBe('not_started');
    expect(integrationHealth(row({ status: 'completed', ws_overdue: 5 }))).toBe('on_track');
  });
  it('weights margin by revenue and ignores companies without data', () => {
    const t = portfolioTotals([row(), row({ id: 'b', kpis: { revenue_cents: 300000, gross_margin_pct: 20, utilization_pct: 80, retention_at_risk: 1 } }), row({ id: 'c', kpis: null })]);
    expect(t.revenue).toBe(400000);
    expect(t.margin).toBe(25);
    expect(t.utilization).toBe(70);
    expect(t.retentionAtRisk).toBe(5);
    expect(t.companies).toBe(3);
    expect(t.costPlan).toBe(3000);
    expect(portfolioTotals([]).margin).toBeNull();
  });
  it('formats values', () => {
    expect(formatCents(123456)).toBe('$1,235');
    expect(formatCents(null)).toBe('—');
    expect(formatKpi('gross_margin_pct', 41.234)).toBe('41.2%');
    expect(formatKpi('jobs_count', 1200)).toBe('1,200');
  });
});

describe('synergies', () => {
  const syn = (id: string, over: Partial<Synergy> = {}): Synergy => ({ id, acquisition_id: 'a', kind: 'cost_savings', category: 'procurement', title: id, plan_annual_cents: 120000, start_date: '2027-01-10', status: 'in_progress', notes: null, ...over });
  const act = (synergy_id: string, cents: number, month = '2027-01-01'): SynergyActual => ({ id: `${synergy_id}${month}`, synergy_id, period_month: month, actual_cents: cents, note: null });
  it('accrues plan monthly from the start month, inclusive', () => {
    expect(planToDate(120000, '2027-01-10', '2027-03-15')).toBe(30000);
    expect(planToDate(120000, '2027-06-01', '2027-03-15')).toBe(0);
  });
  it('rolls up cost vs revenue, excludes dropped, reports variance', () => {
    const r = synergyRollup(
      [syn('s1'), syn('s2', { kind: 'revenue_lift', plan_annual_cents: 240000 }), syn('s3', { status: 'dropped' })],
      [act('s1', 9000), act('s1', 11000, '2027-02-01'), act('s2', 60000), act('s3', 999)], '2027-03-15');
    expect(r.cost).toEqual({ plan: 30000, actual: 20000, variance: -10000, pct: 66.7, annual: 120000 });
    expect(r.revenue.plan).toBe(60000);
    expect(r.revenue.pct).toBe(100);
    expect(r.lines).toHaveLength(2);
  });
  it('has no percentage before any plan has accrued', () => {
    expect(synergyRollup([syn('s1', { start_date: '2027-09-01' })], [], '2027-03-15').cost.pct).toBeNull();
  });
});

describe('money and validation', () => {
  it('parses dollars to cents safely', () => {
    expect(parseMoneyToCents('1,250.50')).toBe(125050);
    expect(parseMoneyToCents('$12')).toBe(1200);
    expect(parseMoneyToCents('12.345')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('')).toBeNull();
  });
  it('validates a new acquisition', () => {
    const ok = { ...EMPTY_DRAFT(TODAY), name: 'Acme Plumbing' };
    expect(validateNewAcquisition(ok, TODAY)).toEqual({});
    expect(validateNewAcquisition({ ...ok, name: '  ' }, TODAY).name).toBeTruthy();
    expect(validateNewAcquisition({ ...ok, scope_kind: 'linked_account' }, TODAY).franchise_location_id).toBeTruthy();
    expect(validateNewAcquisition({ ...ok, purchase_price: '-5' }, TODAY).purchase_price).toBeTruthy();
    expect(validateNewAcquisition({ ...ok, close_date: '2040-01-01' }, TODAY).close_date).toBeTruthy();
    expect(validateNewAcquisition({ ...ok, currency: 'US' }, TODAY).currency).toBeTruthy();
  });
  it('validates synergies, actuals and controls', () => {
    expect(validateSynergy({ kind: 'cost_savings', category: 'other', title: '', plan_annual: 'x', start_date: 'bad', status: 'planned', notes: '' })).toMatchObject({ title: expect.anything() });
    expect(validateActual('2027-02', '1500')).toEqual({});
    expect(validateActual('2027-2', '1500').month).toBeTruthy();
    expect(validateControl('customers_count', { value: '1,204', tolerance: '', label: '' }).count).toBe(1204);
    expect(validateControl('customers_count', { value: '12.5', tolerance: '', label: '' }).value).toBeTruthy();
    expect(validateControl('paid_cents', { value: '1000.25', tolerance: '1', label: '' }).cents).toBe(100025);
    expect(validateControl('paid_cents', { value: '5', tolerance: '80', label: '' }).tolerance).toBeTruthy();
  });
  it('builds a manual baseline from typed values', () => {
    const r = buildBaselineMetrics({ revenue_cents: '250,000', gross_margin_pct: '38.5', jobs_count: '' });
    expect(r.errors).toEqual({});
    expect(r.metrics).toEqual({ revenue_cents: 25000000, gross_margin_pct: 38.5 });
    expect(buildBaselineMetrics({ retention_pct: '140' }).errors.retention_pct).toBeTruthy();
    expect(Object.keys(buildBaselineMetrics({}).errors)).toHaveLength(1);
  });
});
