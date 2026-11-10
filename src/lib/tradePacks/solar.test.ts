import { describe, it, expect, beforeEach } from 'vitest';
// The migration is read as text at build time (Vite `?raw`), so the test needs no Node typings.
import migrationSql from '../../../supabase/migrations/20290301000000_solar_pack.sql?raw';
import { INDUSTRIES } from '@/lib/industries';
import { normalizeField } from '@/lib/offline/formSchema';
import {
  CLAIM_STATUSES, CLAIM_TRANSITIONS, SOLAR_PACK, SOLAR_STAGE_KEYS, STAGE_DEPENDENCIES, STAGE_STATUSES, STAGE_TRANSITIONS, TRADE_PACKS,
  addDaysISO, addYearsISO, availableStageMoves, canCompleteProject, canTransitionStage, claimCoverage, claimTransitionError, clearSolarFinancingHooks,
  daysUntil, effectiveWarrantyEnd, emitSolarFinancingEvent, expectedDailyKwh, getLogType, getMonitoringAdapter, isStageOverdue, jobMatchesPack,
  jurisdictionNeedsVerification, registerSolarFinancingHook, stageTransitionError, suggestDueDate, summarizePipeline, summarizeProduction,
  unmetDependencies, validateLogData, validateReviewDays, warrantyEnd, warrantyState, getPack, MockProductionMonitoringAdapter,
  type SolarFinancingEvent, type StageLike, type SolarStageKey, type StageStatus,
} from './index';

const sql: string = migrationSql;
const mk = (over: Partial<Record<SolarStageKey, StageStatus>> = {}): StageLike[] =>
  SOLAR_STAGE_KEYS.map((k) => ({ stage_key: k, status: over[k] ?? 'not_started', due_date: null }));
const long = 'reason given';

describe('pipeline transitions', () => {
  it('allows exactly the documented moves and nothing else', () => {
    for (const from of STAGE_STATUSES) for (const to of STAGE_STATUSES) expect(canTransitionStage(from, to)).toBe(STAGE_TRANSITIONS[from].includes(to));
    expect(canTransitionStage('approved', 'in_progress')).toBe(false);
    expect(canTransitionStage('skipped', 'in_progress')).toBe(false);
    expect(canTransitionStage('in_progress', 'approved')).toBe(false);
  });
  it('blocks starting a stage until its dependencies are approved or skipped', () => {
    const s = mk();
    expect(unmetDependencies('permit', s)).toEqual(['design']);
    expect(stageTransitionError(s[1], 'in_progress', s)).toMatch(/Waiting on: Design/);
    expect(stageTransitionError(s[0], 'in_progress', s)).toBeNull();
    expect(stageTransitionError(mk({ design: 'approved' })[1], 'in_progress', mk({ design: 'approved' }))).toBeNull();
    expect(unmetDependencies('permit', mk({ design: 'skipped' }))).toEqual([]);
  });
  it('PTO needs both inspection and interconnection', () => {
    expect(unmetDependencies('pto', mk({ inspection: 'approved' }))).toEqual(['interconnection']);
    expect(unmetDependencies('pto', mk({ inspection: 'approved', interconnection: 'skipped' }))).toEqual([]);
  });
  it('skip / reject / corrections require a reason', () => {
    const s = mk();
    expect(stageTransitionError(s[0], 'skipped', s, '')).toMatch(/reason/);
    expect(stageTransitionError(s[0], 'skipped', s, long)).toBeNull();
    const sub = mk({ design: 'submitted' });
    expect(stageTransitionError(sub[0], 'rejected', sub, 'no')).toMatch(/reason/);
    expect(stageTransitionError(sub[0], 'approved', sub)).toBeNull();
    expect(stageTransitionError(sub[0], 'corrections_required', sub, long)).toBeNull();
  });
  it('rework loop and terminal states', () => {
    expect(canTransitionStage('corrections_required', 'submitted')).toBe(true);
    expect(canTransitionStage('rejected', 'in_progress')).toBe(true);
    expect(availableStageMoves(mk({ design: 'approved' })[0], mk({ design: 'approved' }))).toEqual([]);
    expect(availableStageMoves(mk()[1], mk())).toEqual([]);
  });
  it('overdue ignores finished stages and today', () => {
    expect(isStageOverdue({ status: 'in_progress', due_date: '2030-01-01' }, '2030-01-02')).toBe(true);
    expect(isStageOverdue({ status: 'in_progress', due_date: '2030-01-02' }, '2030-01-02')).toBe(false);
    expect(isStageOverdue({ status: 'approved', due_date: '2020-01-01' }, '2030-01-02')).toBe(false);
    expect(isStageOverdue({ status: 'in_progress', due_date: null }, '2030-01-02')).toBe(false);
  });
  it('summary + completion', () => {
    const s = mk({ design: 'approved', permit: 'in_progress' });
    s[1].due_date = '2020-01-01';
    expect(summarizePipeline(s, '2030-01-01')).toMatchObject({ done: 1, total: 5, current: 'permit', overdue: ['permit'], blocked: ['inspection', 'pto'] });
    expect(canCompleteProject(s)).toBe(false);
    expect(canCompleteProject(mk({ design: 'approved', permit: 'approved', interconnection: 'skipped', inspection: 'approved', pto: 'approved' }))).toBe(true);
    expect(canCompleteProject([])).toBe(false);
  });
  it('suggested due dates come only from valid configured days', () => {
    expect(suggestDueDate('permit', '2030-01-30', { permit: 15 })).toBe('2030-02-14');
    expect(suggestDueDate('permit', '2030-01-30', {})).toBeNull();
    expect(suggestDueDate('permit', '2030-01-30', { permit: -1 })).toBeNull();
    expect(suggestDueDate('permit', '2030-01-30', { permit: 400 })).toBeNull();
    expect(suggestDueDate('permit', '2030-01-30', undefined)).toBeNull();
  });
  it('jurisdiction rules: whole days 0–365 on known stages; needs verification until reviewed', () => {
    expect(validateReviewDays({ permit: 10, pto: 0 })).toEqual([]);
    expect(validateReviewDays({ roof: 3 })[0]).toMatch(/Unknown/);
    expect(validateReviewDays({ permit: 1.5 })[0]).toMatch(/whole/);
    expect(validateReviewDays({ permit: 366 })[0]).toMatch(/whole/);
    expect(validateReviewDays({ permit: '5' })[0]).toMatch(/whole/);
    expect(jurisdictionNeedsVerification(null)).toBe(true);
    expect(jurisdictionNeedsVerification({ verified_at: null })).toBe(true);
    expect(jurisdictionNeedsVerification({ verified_at: '2030-01-01T00:00:00Z' })).toBe(false);
  });
});

describe('warranty expiry', () => {
  it('adds years with leap-day clamping and ends one day before the anniversary', () => {
    expect(addYearsISO('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYearsISO('2024-02-29', 4)).toBe('2028-02-29');
    expect(warrantyEnd('2024-03-15', 10)).toBe('2034-03-14');
    expect(warrantyEnd('2024-01-01', 1)).toBe('2024-12-31');
    expect(warrantyEnd('2024-02-29', 1)).toBe('2025-02-27');
    expect(warrantyEnd(null, 10)).toBeNull();
    expect(warrantyEnd('2024-01-01', null)).toBeNull();
    expect(warrantyEnd('2024-01-01', 0)).toBeNull();
    expect(addDaysISO('2024-12-31', 1)).toBe('2025-01-01');
  });
  it('manufacturer override wins over the computed end', () => {
    const u = { warranty_start: '2024-03-15', product_warranty_years: 10, warranty_expires_override: null };
    expect(effectiveWarrantyEnd(u)).toBe('2034-03-14');
    expect(effectiveWarrantyEnd({ ...u, warranty_expires_override: '2035-06-01' })).toBe('2035-06-01');
    expect(effectiveWarrantyEnd({ warranty_start: null, product_warranty_years: null, warranty_expires_override: null })).toBeNull();
  });
  it('state: unknown / active / expiring soon / expired, inclusive last day', () => {
    expect(warrantyState(null, '2030-01-01')).toBe('unknown');
    expect(warrantyState('2030-12-31', '2030-01-01')).toBe('active');
    expect(warrantyState('2030-03-01', '2030-01-01')).toBe('expiring_soon');
    expect(warrantyState('2030-01-01', '2030-01-01')).toBe('expiring_soon');
    expect(warrantyState('2029-12-31', '2030-01-01')).toBe('expired');
    expect(daysUntil('2030-01-31', '2030-01-01')).toBe(30);
  });
  it('claim coverage uses the failure date, not today', () => {
    const u = { warranty_start: '2024-03-15', product_warranty_years: 10, warranty_expires_override: null };
    expect(claimCoverage(u, '2034-03-14')).toBe('in_warranty');
    expect(claimCoverage(u, '2034-03-15')).toBe('expired');
    expect(claimCoverage(u, '2024-03-14')).toBe('unknown');
    expect(claimCoverage({ warranty_start: null, product_warranty_years: null, warranty_expires_override: null }, '2030-01-01')).toBe('unknown');
  });
});

describe('warranty claim workflow', () => {
  const base = { status: 'draft' as const, warranty_state: 'in_warranty' as const, goodwill: false, resolution: null };
  it('matrix is closed: terminal states have no exits', () => {
    expect(CLAIM_TRANSITIONS.closed).toEqual([]);
    expect(CLAIM_TRANSITIONS.withdrawn).toEqual([]);
    for (const s of CLAIM_STATUSES) for (const t of CLAIM_TRANSITIONS[s]) expect(CLAIM_STATUSES).toContain(t);
  });
  it('cannot file out-of-warranty or unknown-coverage claims without goodwill', () => {
    expect(claimTransitionError(base, 'submitted')).toBeNull();
    expect(claimTransitionError({ ...base, warranty_state: 'expired' }, 'submitted')).toMatch(/goodwill/);
    expect(claimTransitionError({ ...base, warranty_state: 'unknown' }, 'submitted')).toMatch(/warranty terms/);
    expect(claimTransitionError({ ...base, warranty_state: 'expired', goodwill: true }, 'submitted')).toBeNull();
  });
  it('deny / withdraw need a reason; resolve needs a resolution; no skipping steps', () => {
    expect(claimTransitionError({ ...base, status: 'submitted' }, 'denied', '')).toMatch(/reason/);
    expect(claimTransitionError({ ...base, status: 'submitted' }, 'denied', long)).toBeNull();
    expect(claimTransitionError({ ...base, status: 'approved' }, 'resolved')).toMatch(/resolution/);
    expect(claimTransitionError({ ...base, status: 'approved' }, 'resolved', null, 'replace')).toBeNull();
    expect(claimTransitionError(base, 'approved')).toMatch(/cannot move/);
    expect(claimTransitionError({ ...base, status: 'denied' }, 'under_review')).toBeNull();
  });
});

describe('manifest', () => {
  const pack = SOLAR_PACK;
  it('registers behind the framework and matches a marketing industry', () => {
    expect(TRADE_PACKS).toContain(pack);
    expect(getPack('solar')).toBe(pack);
    expect(INDUSTRIES.some((i) => i.slug === pack.industrySlug)).toBe(true);
  });
  it('field keys and form slugs carry the solar_ prefix and fit install_trade_pack limits', () => {
    expect(pack.customFields.length).toBeLessThanOrEqual(30);
    expect(pack.forms.length).toBeLessThanOrEqual(20);
    for (const f of pack.customFields) expect(f.key.startsWith('solar_')).toBe(true);
    for (const f of pack.forms) {
      expect(f.slug).toMatch(/^solar_[a-z0-9_]{1,54}$/);
      for (const field of f.fields) expect(normalizeField(field), `${f.slug}.${field.id}`).not.toBeNull();
    }
  });
  it('survey has required photos; checklists never claim compliance', () => {
    const survey = pack.forms.find((f) => f.slug === 'solar_site_survey')!;
    expect(survey.fields.filter((f) => f.type === 'photo' && f.required).length).toBeGreaterThanOrEqual(3);
    for (const f of pack.forms) for (const field of f.fields) expect(field.label.toLowerCase()).not.toMatch(/code[- ]compliant|nec compliant|certified compliant/);
    expect(pack.complianceNote).toMatch(/REQUIRES COUNSEL/);
  });
  it('every plan points at a real pricing model', () => {
    for (const p of pack.plans) expect(pack.pricingModels.some((m) => m.key === p.pricingModel)).toBe(true);
  });
  it('matches solar jobs only', () => {
    expect(jobMatchesPack(pack, 'Solar panel install')).toBe(true);
    expect(jobMatchesPack(pack, 'Battery storage install')).toBe(true);
    expect(jobMatchesPack(pack, 'AC tune-up')).toBe(false);
  });
  it('commissioning record validates', () => {
    const t = getLogType(pack, 'commissioning_record')!;
    const ok = { system_size_kw_dc: 8.4, monitoring_connected: true, rapid_shutdown_tested: true, labels_placed: true, result: 'Completed — no open items' };
    expect(validateLogData(t, ok)).toEqual([]);
    expect(validateLogData(t, { ...ok, result: 'Certified' })[0]).toMatch(/invalid choice/);
    expect(validateLogData(t, { ...ok, array_voc_v: 5000 })[0]).toMatch(/at most/);
    expect(validateLogData(t, {}).length).toBeGreaterThan(3);
  });
});

describe('manifest <-> database', () => {
  const specFor = (entry: string) => {
    const m = sql.match(new RegExp(`'solar', '${entry}'[\\s\\S]*?'(\\{"fields".*?\\})'::jsonb`));
    expect(m).not.toBeNull();
    return JSON.parse((m as RegExpMatchArray)[1]);
  };
  const manifestSpec = (key: string) => ({
    fields: getLogType(SOLAR_PACK, key)!.fields.map((f) => ({
      key: f.key, type: f.type, required: !!f.required,
      ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}), ...(f.options ? { options: f.options } : {}),
    })),
    at_least_one_of: getLogType(SOLAR_PACK, key)!.atLeastOneOf ?? [],
  });
  it('seeds exactly the log-type specs the manifest declares', () => {
    for (const t of SOLAR_PACK.logTypes) expect(specFor(t.key)).toEqual(manifestSpec(t.key));
  });
  it('retention years agree', () => {
    for (const t of SOLAR_PACK.logTypes) expect(sql).toMatch(new RegExp(`'solar', '${t.key}'[^;]*?, ${t.retentionYears},\\s*'\\{`));
  });
  const q = (a: readonly string[]) => a.map((x) => `'${x}'`).join(', ');
  it('stage transition + dependency functions mirror the TypeScript matrix', () => {
    for (const from of STAGE_STATUSES) {
      const to = STAGE_TRANSITIONS[from];
      if (to.length) expect(sql).toContain(`WHEN '${from}' THEN p_to IN (${q(to)})`);
    }
    for (const k of SOLAR_STAGE_KEYS) {
      const d = STAGE_DEPENDENCIES[k];
      if (d.length) expect(sql).toContain(`WHEN '${k}' THEN ARRAY[${q(d)}]`);
    }
    expect(sql).toContain(`CHECK (stage_key IN (${q(SOLAR_STAGE_KEYS)}))`);
    expect(sql).toContain(`CHECK (status IN (${q(STAGE_STATUSES)}))`);
  });
  it('claim transition function mirrors the TypeScript matrix', () => {
    for (const from of CLAIM_STATUSES) {
      const to = CLAIM_TRANSITIONS[from];
      if (to.length) expect(sql).toContain(`WHEN '${from}' THEN p_to IN (${q(to)})`);
    }
    expect(sql).toContain(`CHECK (status IN (${q(CLAIM_STATUSES)}))`);
  });
  it('is default-OFF, entitlement-gated, and never grants client status writes', () => {
    expect(sql).toMatch(/'trade_pack_solar'[\s\S]{0,400}false, 0\)/);
    expect(sql).toContain("module_entitled(p_tenant, 'packs:solar')");
    expect(sql).toContain('REVOKE INSERT, DELETE, UPDATE ON solar_pipeline_stages FROM anon, authenticated');
    expect(sql).toContain('GRANT UPDATE (owner_id, due_date, reference_number, notes) ON solar_pipeline_stages');
    expect(sql).not.toMatch(/FOR DELETE TO authenticated/);
    expect(sql).not.toMatch(/DROP TABLE IF EXISTS[^;]*;\s*\n(?!\s*--)[^\n]*\n\s*CREATE TABLE/);
  });
  it('every solar table enables RLS', () => {
    for (const t of ['solar_jurisdiction_profiles', 'solar_projects', 'solar_pipeline_stages', 'solar_workflow_events', 'solar_equipment_units', 'solar_warranty_claims', 'account_module_entitlements'])
      expect(sql).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
  });
  it('SQL warranty-end formula matches the TypeScript convention', () => {
    expect(sql).toContain('((p_start + make_interval(years => p_years))::date - 1)');
  });
});

describe('monitoring adapter (mock, read-only)', () => {
  const a = new MockProductionMonitoringAdapter();
  const range = { from: '2030-06-01', to: '2030-06-10' };
  it('is deterministic and bounded', async () => {
    const x = await a.getProduction('site-1', range);
    const y = await a.getProduction('site-1', range);
    expect(x.points).toEqual(y.points);
    expect(x.points).toHaveLength(10);
    expect(x.points.every((p) => p.kwh > 0)).toBe(true);
    expect(a.readOnly).toBe(true);
  });
  it('rejects bad input and flags offline sites', async () => {
    await expect(a.getProduction('  ', range)).rejects.toThrow('monitoring_site_required');
    await expect(a.getProduction('s', { from: '2030-06-10', to: '2030-06-01' })).rejects.toThrow('monitoring_range_invalid');
    const off = await a.getProduction('x-offline', range);
    expect(off.status).toBe('offline');
    expect(summarizeProduction(off, expectedDailyKwh(8)).underperforming).toBe(true);
  });
  it('only the mock provider resolves', () => {
    expect(getMonitoringAdapter('mock')).toBeTruthy();
    expect(getMonitoringAdapter('none')).toBeNull();
    expect(getMonitoringAdapter('enphase')).toBeNull();
    expect(getMonitoringAdapter(null)).toBeNull();
  });
});

describe('financing hook (isolated)', () => {
  beforeEach(() => clearSolarFinancingHooks());
  const ev: SolarFinancingEvent = { type: 'stage_changed', eventId: 'e1', projectId: 'p', stageKey: 'permit', from: 'submitted', to: 'approved', at: '2030-01-01T00:00:00Z' };
  it('delivers to every hook and never throws when one fails', async () => {
    const got: string[] = [];
    registerSolarFinancingHook({ id: 'bad', onEvent: () => { throw new Error('boom'); } });
    const off = registerSolarFinancingHook({ id: 'good', onEvent: (e) => { got.push(e.eventId); } });
    expect(await emitSolarFinancingEvent(ev)).toEqual({ delivered: 1, failed: [{ id: 'bad', error: 'boom' }] });
    expect(got).toEqual(['e1']);
    off();
    expect((await emitSolarFinancingEvent(ev)).delivered).toBe(0);
  });
  it('no hooks registered is a no-op', async () => {
    expect(await emitSolarFinancingEvent(ev)).toEqual({ delivered: 0, failed: [] });
  });
});
