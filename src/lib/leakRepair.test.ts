import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  ALD_MAX_CALIBRATION_AGE_DAYS,
  ANNUAL_INSPECTION_COUNT,
  CHRONIC_LEAK_PCT,
  FOLLOWUP_JOB_LEAD_DAYS,
  LEAK_COVERED_GWP_EXCLUSIVE_MIN,
  LEAK_DUE_SOON_DAYS,
  LEAK_FOLLOWUP_TEST_DAYS,
  LEAK_REPAIR_DEADLINE_DAYS,
  LEAK_RETROFIT_COMPLETE_YEARS,
  LEAK_RETROFIT_PLAN_DAYS,
  LEAK_RULE_MIN_CHARGE_LBS,
  LEAK_THRESHOLD_PCT,
  QUARTERLY_INSPECTION_COUNT,
  QUARTERLY_INSPECTION_MIN_LBS,
  RECORD_RETENTION_YEARS,
  REFRIGERANTS,
  TYPE_I_MAX_CHARGE_LBS,
  computeLeakRate,
  isRegulatedAppliance,
  type CredentialLike,
} from '@/lib/refrigerantCompliance';
import {
  HAWK_COLUMNS,
  LEAK_TRANSITIONS,
  addDays,
  addMonths,
  aldWaiverApplies,
  calendarYearLeakPct,
  canTransition,
  caseRetainUntil,
  checkTestSigner,
  daysBetween,
  daysToNextAction,
  evaluateLeakTrigger,
  followUpTestDueOn,
  friendlyLeakError,
  hasDatedNextAction,
  hawkFilename,
  inspectionCadence,
  inspectionSchedule,
  isChronicLeaker,
  isLive,
  leakUrgency,
  retrofitDates,
  sortCases,
  utcDay,
  validateTest,
  type ChronicCandidate,
  type LeakCaseStatus,
} from '@/lib/leakRepair';
import vectors from '@/lib/__fixtures__/leakParityVectors.json';

const NOW = new Date('2026-10-18T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const add = (id: string, lbs: number, daysAgo: number) => ({
  id,
  event_type: 'added' as const,
  pounds: lbs,
  performed_at: ago(daysAgo),
  voided_at: null,
});
const cred = (over: Partial<CredentialLike> = {}): CredentialLike => ({
  id: 'c1',
  technician_id: 't1',
  credential_type: 'epa_608_universal',
  credential_number: 'EPA-1',
  status: 'active',
  expires_at: null,
  ...over,
});

/* ------------------------------------------------------------------ */

describe('date math', () => {
  it('adds days across month and year ends and leap days', () => {
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('adds months clamped to month end, never drifting', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonths('2026-10-18', 12)).toBe('2027-10-18');
  });

  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-10-18', '2026-11-17')).toBe(30);
    expect(daysBetween('2026-10-18', '2026-10-10')).toBe(-8);
    expect(daysBetween('2026-10-18', '2026-10-18')).toBe(0);
  });

  it('second verification test: +10 days, or +10 after return to normal operation if later', () => {
    expect(followUpTestDueOn('2026-10-18')).toBe('2026-10-28');
    expect(followUpTestDueOn('2026-10-18', '2026-10-15')).toBe('2026-10-28');
    expect(followUpTestDueOn('2026-10-18', '2026-11-01')).toBe('2026-11-11');
    expect(followUpTestDueOn('2026-12-25')).toBe('2027-01-04');
  });

  it('retrofit/retire plan: draft due in 30 days, completion within 1 year', () => {
    expect(retrofitDates('2026-10-18')).toEqual({
      planDueOn: '2026-11-17',
      completeBy: '2027-10-18',
    });
    expect(retrofitDates('2028-02-29')).toEqual({
      planDueOn: '2028-03-30',
      completeBy: '2029-02-28',
    });
  });

  it('3-year retention', () => {
    expect(caseRetainUntil('2026-10-18T10:00:00Z')).toBe('2029-10-18');
    expect(caseRetainUntil('2028-02-29')).toBe('2031-02-28');
  });

  it('utcDay uses the UTC calendar day', () => {
    expect(utcDay('2026-10-18T23:59:59-05:00')).toBe('2026-10-19');
    expect(utcDay(new Date('2026-10-18T00:00:00Z'))).toBe('2026-10-18');
  });
});

describe('follow-up inspection schedule', () => {
  it('quarterly for >= 500 lb, annual below', () => {
    expect(inspectionCadence(500)).toBe('quarterly');
    expect(inspectionCadence(499.99)).toBe('annual');
    expect(inspectionCadence(15)).toBe('annual');
  });

  it('quarterly = 4 inspections anchored on the verification date', () => {
    const s = inspectionSchedule('2026-10-18', 600);
    expect(s.cadence).toBe('quarterly');
    expect(s.dueDates).toEqual(['2027-01-18', '2027-04-18', '2027-07-18', '2027-10-18']);
  });

  it('anchors month-end verification dates without drift (Nov 30)', () => {
    expect(inspectionSchedule('2026-11-30', 800).dueDates).toEqual([
      '2027-02-28',
      '2027-05-30',
      '2027-08-30',
      '2027-11-30',
    ]);
  });

  it('annual = 1 inspection 12 months out', () => {
    expect(inspectionSchedule('2026-10-18', 40)).toEqual({
      cadence: 'annual',
      dueDates: ['2027-10-18'],
    });
  });

  it('is waived only with a calibrated ALD that is not stale', () => {
    const base = { verifiedOn: '2026-10-18' };
    expect(aldWaiverApplies({ ...base, aldCalibrated: true, aldCalibratedOn: '2026-09-01' })).toBe(
      true,
    );
    expect(aldWaiverApplies({ ...base, aldCalibrated: false, aldCalibratedOn: '2026-09-01' })).toBe(
      false,
    );
    expect(aldWaiverApplies({ ...base, aldCalibrated: true, aldCalibratedOn: null })).toBe(false);
    expect(aldWaiverApplies({ ...base, aldCalibrated: true, aldCalibratedOn: '2025-10-18' })).toBe(
      true,
    );
    expect(aldWaiverApplies({ ...base, aldCalibrated: true, aldCalibratedOn: '2025-10-17' })).toBe(
      false,
    );
  });
});

describe('coverage and thresholds', () => {
  it('covers >= 15 lb with GWP > 53 (unknown refrigerant is covered, conservatively)', () => {
    expect(isRegulatedAppliance(15, 'R-410A')).toBe(true);
    expect(isRegulatedAppliance(14.99, 'R-410A')).toBe(false);
    expect(isRegulatedAppliance(100, 'r410a')).toBe(true);
    for (const low of ['R-290', 'R-600a', 'R-717', 'R-744']) {
      expect(isRegulatedAppliance(500, low)).toBe(false);
    }
    expect(isRegulatedAppliance(50, 'XYZ-9')).toBe(true);
    expect(isRegulatedAppliance(50, null)).toBe(true);
    expect(isRegulatedAppliance(null, 'R-410A')).toBe(false);
    expect(isRegulatedAppliance(Number.NaN, 'R-410A')).toBe(false);
  });

  it.each([
    ['comfort_cooling', 10],
    ['commercial_refrigeration', 20],
    ['industrial_process', 30],
  ] as const)('%s opens a case above %i%% but not at exactly %i%%', (category, limit) => {
    const at = evaluateLeakTrigger({
      entries: [add('a', limit, 30)],
      fullChargeLbs: 100,
      category,
      refrigerantType: 'R-410A',
      asOf: NOW,
    });
    expect(at.leak.rollingPct).toBe(limit);
    expect(at.shouldOpenCase).toBe(false);
    const over = evaluateLeakTrigger({
      entries: [add('a', limit + 0.5, 30)],
      fullChargeLbs: 100,
      category,
      refrigerantType: 'R-410A',
      asOf: NOW,
    });
    expect(over.shouldOpenCase).toBe(true);
  });

  it('never opens a case for small units or low-GWP refrigerants', () => {
    expect(
      evaluateLeakTrigger({
        entries: [add('a', 9, 3)],
        fullChargeLbs: 10,
        refrigerantType: 'R-410A',
        asOf: NOW,
      }).shouldOpenCase,
    ).toBe(false);
    expect(
      evaluateLeakTrigger({
        entries: [add('a', 50, 3)],
        fullChargeLbs: 60,
        refrigerantType: 'R-290',
        asOf: NOW,
      }).shouldOpenCase,
    ).toBe(false);
  });

  it('repair deadline = exceeding addition + 30 days', () => {
    const r = evaluateLeakTrigger({
      entries: [add('a', 8, 3)],
      fullChargeLbs: 40,
      category: 'comfort_cooling',
      refrigerantType: 'R-410A',
      asOf: NOW,
    });
    expect(LEAK_REPAIR_DEADLINE_DAYS).toBe(30);
    expect(r.repairDueAt).toBe(new Date(new Date(ago(3)).getTime() + 30 * DAY).toISOString());
  });

  it('ignores voided additions and additions before a verified repair (baseline reset)', () => {
    const entries = [
      add('old', 8, 300),
      { ...add('v', 20, 2), voided_at: ago(1) },
      add('new', 1, 1),
    ];
    const reset = evaluateLeakTrigger({
      entries,
      fullChargeLbs: 40,
      category: 'comfort_cooling',
      refrigerantType: 'R-410A',
      baselineResetAt: ago(298),
      asOf: NOW,
    });
    expect(reset.leak.poundsAdded365).toBe(1);
    expect(reset.shouldOpenCase).toBe(false);
    const noReset = evaluateLeakTrigger({
      entries,
      fullChargeLbs: 40,
      category: 'comfort_cooling',
      refrigerantType: 'R-410A',
      asOf: NOW,
    });
    expect(noReset.leak.poundsAdded365).toBe(9);
    expect(noReset.shouldOpenCase).toBe(true);
  });
});

describe('chronic leaker (>125% in a calendar year)', () => {
  it('uses the calendar year and ignores voided rows', () => {
    const entries = [
      {
        event_type: 'added' as const,
        pounds: 40,
        performed_at: '2026-02-01T00:00:00Z',
        voided_at: null,
      },
      {
        event_type: 'added' as const,
        pounds: 30,
        performed_at: '2026-06-01T00:00:00Z',
        voided_at: null,
      },
      {
        event_type: 'added' as const,
        pounds: 99,
        performed_at: '2026-07-01T00:00:00Z',
        voided_at: '2026-07-02T00:00:00Z',
      },
      {
        event_type: 'added' as const,
        pounds: 99,
        performed_at: '2025-12-31T23:59:59Z',
        voided_at: null,
      },
      {
        event_type: 'recovered' as const,
        pounds: 50,
        performed_at: '2026-08-01T00:00:00Z',
        voided_at: null,
      },
    ];
    expect(calendarYearLeakPct(entries, 50, 2026)).toBe(140);
    expect(isChronicLeaker(140)).toBe(true);
    expect(isChronicLeaker(CHRONIC_LEAK_PCT)).toBe(false);
    expect(isChronicLeaker(null)).toBe(false);
    expect(calendarYearLeakPct(entries, null, 2026)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe('case lifecycle', () => {
  const statuses = Object.keys(LEAK_TRANSITIONS) as LeakCaseStatus[];

  it('walks the happy path open -> initial_verified -> verified -> followup_scheduled -> closed', () => {
    const path: LeakCaseStatus[] = [
      'open',
      'initial_verified',
      'verified',
      'followup_scheduled',
      'closed',
    ];
    for (let i = 0; i < path.length - 1; i++)
      expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('allows ALD waiver (verified -> closed) and failure from any live state', () => {
    expect(canTransition('verified', 'closed')).toBe(true);
    for (const s of ['open', 'initial_verified', 'verified', 'followup_scheduled'] as const) {
      expect(canTransition(s, 'failed')).toBe(true);
      expect(canTransition(s, 'voided')).toBe(true);
    }
    expect(canTransition('failed', 'closed')).toBe(true);
  });

  it('never leaves a terminal state and cannot skip steps', () => {
    for (const to of statuses) {
      expect(canTransition('closed', to)).toBe(false);
      expect(canTransition('voided', to)).toBe(false);
    }
    expect(canTransition('open', 'verified')).toBe(false);
    expect(canTransition('open', 'closed')).toBe(false);
    expect(canTransition('initial_verified', 'followup_scheduled')).toBe(false);
    expect(canTransition('failed', 'open')).toBe(false);
  });

  it('a live case always needs a dated next action', () => {
    expect(
      hasDatedNextAction({
        status: 'open',
        next_action: 'initial_verification',
        next_action_due_at: '2026-11-01',
      }),
    ).toBe(true);
    expect(
      hasDatedNextAction({ status: 'open', next_action: null, next_action_due_at: null }),
    ).toBe(false);
    expect(
      hasDatedNextAction({
        status: 'failed',
        next_action: 'submit_retrofit_plan',
        next_action_due_at: null,
      }),
    ).toBe(false);
    expect(
      hasDatedNextAction({ status: 'closed', next_action: null, next_action_due_at: null }),
    ).toBe(true);
    expect(isLive('voided')).toBe(false);
    expect(isLive('failed')).toBe(true);
  });

  it('flags overdue / due soon / on track', () => {
    const c = (due: string | null, status: LeakCaseStatus = 'open') => ({
      status,
      next_action: due ? ('initial_verification' as const) : null,
      next_action_due_at: due,
    });
    expect(leakUrgency(c('2026-10-17'), NOW)).toBe('overdue');
    expect(leakUrgency(c('2026-10-18'), NOW)).toBe('due_soon');
    expect(leakUrgency(c('2026-10-25'), NOW)).toBe('due_soon');
    expect(LEAK_DUE_SOON_DAYS).toBe(7);
    expect(leakUrgency(c('2026-10-26'), NOW)).toBe('on_track');
    expect(leakUrgency(c(null, 'closed'), NOW)).toBe('none');
    expect(daysToNextAction(c('2026-10-10'), NOW)).toBe(-8);
  });

  it('sorts overdue first, then soonest, finished last', () => {
    const mk = (id: string, due: string | null, status: LeakCaseStatus = 'open') => ({
      id,
      status,
      next_action: due ? ('initial_verification' as const) : null,
      next_action_due_at: due,
      opened_at: '2026-10-01T00:00:00Z',
    });
    const sorted = sortCases(
      [
        mk('closed', null, 'closed'),
        mk('later', '2026-12-01'),
        mk('overdue', '2026-10-01'),
        mk('soon', '2026-10-20'),
      ],
      NOW,
    ).map((c) => c.id);
    expect(sorted).toEqual(['overdue', 'soon', 'later', 'closed']);
  });
});

describe('verification test signing', () => {
  it('rejects an expired certification on the test date', () => {
    const c = cred({ expires_at: '2026-10-17' });
    const r = checkTestSigner([c], 't1', NOW, 40);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired|revoked/);
  });

  it('judges the certification on the test date, not today', () => {
    const c = cred({ expires_at: '2026-10-01' });
    expect(checkTestSigner([c], 't1', new Date('2026-09-30T10:00:00Z'), 40).ok).toBe(true);
    expect(checkTestSigner([c], 't1', new Date('2026-10-02T10:00:00Z'), 40).ok).toBe(false);
  });

  it('rejects revoked and pending-renewal certifications and technicians with none', () => {
    expect(checkTestSigner([cred({ status: 'revoked' })], 't1', NOW, 40).ok).toBe(false);
    expect(checkTestSigner([cred({ status: 'pending_renewal' })], 't1', NOW, 40).ok).toBe(false);
    expect(checkTestSigner([], 't1', NOW, 40).ok).toBe(false);
    expect(checkTestSigner([cred()], null, NOW, 40).ok).toBe(false);
  });

  it('Type I cannot sign for a unit over 5 lb', () => {
    const typeI = cred({ credential_type: 'epa_608_type_i' });
    expect(checkTestSigner([typeI], 't1', NOW, TYPE_I_MAX_CHARGE_LBS).ok).toBe(true);
    expect(checkTestSigner([typeI], 't1', NOW, 40).ok).toBe(false);
  });

  const open = { status: 'open' as const, detected_at: ago(3), repair_due_at: ago(-27) };
  const good = {
    kind: 'initial' as const,
    result: 'pass' as const,
    technicianId: 't1',
    method: 'bubble_solution' as const,
    performedAt: NOW.toISOString(),
  };

  it('validates a test form', () => {
    expect(validateTest(good, open, NOW)).toEqual([]);
    expect(validateTest({ ...good, technicianId: '' }, open, NOW)).toContain(
      'Choose the technician who signs.',
    );
    expect(validateTest({ ...good, method: '' }, open, NOW)).toContain('Choose the test method.');
    expect(validateTest({ ...good, performedAt: ago(-1) }, open, NOW)).toContain(
      'Test date cannot be in the future.',
    );
    expect(validateTest({ ...good, performedAt: ago(5) }, open, NOW)).toContain(
      'Test date is before the leak was detected.',
    );
    expect(validateTest({ ...good, performedAt: 'nope' }, open, NOW)).toContain(
      'Test date is invalid.',
    );
  });

  it('enforces the test order', () => {
    expect(validateTest({ ...good, kind: 'followup' }, open, NOW)).toContain(
      'Sign the initial test first; the follow-up test comes after it.',
    );
    expect(validateTest(good, { ...open, status: 'initial_verified' }, NOW)).toContain(
      'The initial test can only be signed while the case is open.',
    );
    expect(
      validateTest({ ...good, kind: 'followup' }, { ...open, status: 'initial_verified' }, NOW),
    ).toEqual([]);
  });
});

describe('HAWK chronic-leak export (prepare only)', () => {
  const row: ChronicCandidate = {
    equipment_id: 'e1',
    customer_name: 'Acme Foods',
    site_address: '1 Main St',
    equipment_label: 'Hill R Rack',
    equipment_serial: 'S3',
    refrigerant_type: 'R-404A',
    appliance_category: 'commercial_refrigeration',
    charge_lbs: 100,
    pounds_added: 140.5,
    leak_rate_pct: 140.5,
    additions: 3,
    first_addition_at: '2026-02-01T00:00:00Z',
    last_addition_at: '2026-09-01T00:00:00Z',
    case_count: 1,
    latest_case_status: 'failed',
    year: 2026,
  };

  it('exports one clean row and clearly marks the file as not filed', () => {
    const cells = HAWK_COLUMNS.map((c) => String(c.accessor(row)));
    expect(cells).toContain('140.5');
    expect(cells).toContain('Acme Foods');
    expect(HAWK_COLUMNS.map((c) => c.header)).toContain('Leak rate (% of full charge)');
    expect(hawkFilename(2026)).toBe('hawk-chronic-leak-data_2026_PREPARED-NOT-FILED.csv');
  });
});

describe('friendlyLeakError', () => {
  it('turns server guard errors into plain language', () => {
    expect(
      friendlyLeakError(
        'leak_cert_required: Ed has no valid EPA 608 certification on the test date',
      ),
    ).toBe('Ed has no valid EPA 608 certification on the test date');
    expect(
      friendlyLeakError(
        'leak_case_invalid_state: a followup test cannot be recorded while the case is open',
      ),
    ).toBe('a followup test cannot be recorded while the case is open');
    expect(friendlyLeakError('ald_flag_rpc_only: use set_equipment_ald_flag()')).toMatch(
      /ALD flag/,
    );
    expect(friendlyLeakError('permission denied for table leak_cases')).toBe(
      'You do not have permission to do that.',
    );
    expect(friendlyLeakError('leak test: test date cannot be in the future')).toBe(
      'test date cannot be in the future',
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Parity with the database (guards against the two drifting apart)    */
/* ------------------------------------------------------------------ */

describe('TS <-> SQL parity', () => {
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const file = readdirSync(dir).find((f) => f.endsWith('_refrigerant_leak_repair_loop.sql'));
  const sql = file ? readFileSync(join(dir, file), 'utf8') : '';

  const rule = (key: string): number => {
    const m = sql.match(new RegExp(`'${key}',\\s*(\\d+)`));
    if (!m) throw new Error(`leak_rules() key ${key} not found in the migration`);
    return Number(m[1]);
  };

  it('finds the migration', () => {
    expect(file).toBeTruthy();
  });

  it('leak_rules() equals the TypeScript constants', () => {
    expect(rule('min_charge_lbs')).toBe(LEAK_RULE_MIN_CHARGE_LBS);
    expect(rule('gwp_exclusive_min')).toBe(LEAK_COVERED_GWP_EXCLUSIVE_MIN);
    expect(rule('repair_days')).toBe(LEAK_REPAIR_DEADLINE_DAYS);
    expect(rule('followup_test_days')).toBe(LEAK_FOLLOWUP_TEST_DAYS);
    expect(rule('retrofit_plan_days')).toBe(LEAK_RETROFIT_PLAN_DAYS);
    expect(rule('retrofit_complete_years')).toBe(LEAK_RETROFIT_COMPLETE_YEARS);
    expect(rule('chronic_pct')).toBe(CHRONIC_LEAK_PCT);
    expect(rule('quarterly_min_lbs')).toBe(QUARTERLY_INSPECTION_MIN_LBS);
    expect(rule('quarterly_count')).toBe(QUARTERLY_INSPECTION_COUNT);
    expect(rule('annual_count')).toBe(ANNUAL_INSPECTION_COUNT);
    expect(rule('ald_max_age_days')).toBe(ALD_MAX_CALIBRATION_AGE_DAYS);
    expect(rule('retention_years')).toBe(RECORD_RETENTION_YEARS);
    expect(rule('followup_job_lead_days')).toBe(FOLLOWUP_JOB_LEAD_DAYS);
    expect(rule('due_soon_days')).toBe(LEAK_DUE_SOON_DAYS);
    expect(rule('type_i_max_lbs')).toBe(TYPE_I_MAX_CHARGE_LBS);
  });

  it('category thresholds equal the TypeScript table', () => {
    for (const cat of [
      'comfort_cooling',
      'commercial_refrigeration',
      'industrial_process',
    ] as const) {
      const m = sql.match(new RegExp(`WHEN '${cat}' THEN (\\d+)`));
      expect(Number(m?.[1])).toBe(LEAK_THRESHOLD_PCT[cat]);
    }
  });

  it('refrigerant_gwp rows equal REFRIGERANTS', () => {
    const block = sql.slice(
      sql.indexOf('INSERT INTO refrigerant_gwp'),
      sql.indexOf('ON CONFLICT (code)'),
    );
    const pairs = [...block.matchAll(/\('([^']+)',\s*(\d+)\)/g)].map(
      (m) => [m[1], Number(m[2])] as const,
    );
    expect(pairs.length).toBe(Object.keys(REFRIGERANTS).length);
    for (const [code, gwp] of pairs) expect(REFRIGERANTS[code]?.gwp).toBe(gwp);
  });

  it('every shared vector keeps its recorded result (the SQL harness asserts the same numbers)', () => {
    const asOf = new Date(vectors.asOf);
    for (const v of vectors.vectors) {
      const entries = v.adds.map((a, i) => ({
        id: `e${i}`,
        event_type: 'added' as const,
        pounds: a.lbs,
        performed_at: new Date(asOf.getTime() - a.daysAgo * DAY).toISOString(),
        voided_at: null,
      }));
      const r = computeLeakRate({
        entries,
        fullChargeLbs: v.charge,
        category: v.category as 'comfort_cooling',
        baselineDate:
          v.installDaysAgo === null
            ? null
            : new Date(asOf.getTime() - v.installDaysAgo * DAY).toISOString().slice(0, 10),
        asOf,
      });
      expect({
        rate: r.ratePct,
        rolling: r.rollingPct,
        annual: r.annualizedPct,
        exceeds: r.exceeds,
        lbs: r.poundsAdded365,
        due: r.repairDeadline,
      }).toEqual({
        rate: v.expected.rate_pct,
        rolling: v.expected.rolling_pct,
        annual: v.expected.annualized_pct,
        exceeds: v.expected.exceeds,
        lbs: v.expected.pounds_added_365,
        due: v.expected.repair_due_at,
      });
    }
  });
});
