import { describe, it, expect } from 'vitest';
// The migration is read as text at build time (Vite `?raw`), so the test needs no Node typings.
import migrationSql from '../../../supabase/migrations/20280101000000_pool_water_chemistry.sql?raw';
import {
  CHEMICALS,
  CHEM_IDS,
  DEFAULT_CHOICES,
  POOL_SERVICE_PACK,
  SANITIZER_OPTIONS,
  acidEqToReachPh,
  breakpointLevel,
  cleanLogData,
  convertDose,
  defaultsFromHistory,
  describeDose,
  dicFrom,
  doseForProduct,
  dosingEntryData,
  evaluateWater,
  getLogType,
  productsForRole,
  readingEntryData,
  recommendDosing,
  seriesFor,
  slamLevel,
  sodaAshMolToReachPh,
  solvePh,
  sparkline,
  statusFor,
  targetFc,
  trendDirection,
  validateLogData,
  WATER_BODY_LABELS,
  type DoseStep,
  type DosingInput,
  type LogRowLike,
} from './index';

const base = (over: Partial<DosingInput> = {}): DosingInput => ({
  readings: {},
  body: 'pool',
  sanitizer: 'chlorine',
  volumeGal: 10000,
  ...over,
});
const step = (steps: DoseStep[], id: string) => steps.find((s) => s.id === id);

describe('ranges + evaluation', () => {
  it('uses pool targets from the pack and separate spa targets', () => {
    expect(statusFor('fc', 2, 'pool')).toBe('ok');
    expect(statusFor('fc', 2, 'spa')).toBe('low');
    expect(statusFor('ch', 160, 'pool')).toBe('low');
    expect(statusFor('ch', 160, 'spa')).toBe('ok');
    expect(statusFor('br', 5, 'spa')).toBe('ok');
    expect(statusFor('br', 0.5, 'spa')).toBe('critical_low');
  });
  it('flags spa water above 104 F as critical', () => {
    const ev = evaluateWater({ ph: 7.5, temp_f: 106 }, 'spa');
    expect(ev.heatAlert).toBe(true);
    expect(ev.overall).toBe('critical');
    expect(evaluateWater({ ph: 7.5, temp_f: 106 }, 'pool').heatAlert).toBe(false);
  });
  it('ignores combined chlorine for bromine systems and reports it for chlorine', () => {
    expect(evaluateWater({ fc: 1, tc: 2 }, 'pool', 'bromine').combinedChlorine).toBeNull();
    expect(evaluateWater({ fc: 1, tc: 2 }, 'pool', 'chlorine').combinedChlorine).toBe(1);
  });
});

describe('carbonate model', () => {
  it('round-trips pH through alkalinity and total carbonate', () => {
    const alk = 80 / 50000;
    for (const ph of [6.8, 7.2, 7.5, 7.8, 8.2])
      expect(solvePh(alk, dicFrom(ph, alk))).toBeCloseTo(ph, 4);
  });
  it('acid dose lands on the target pH and grows with the size of the drop', () => {
    const alk = 70 / 50000;
    const eq = acidEqToReachPh(7.8, alk, 7.5)!;
    expect(solvePh(alk - eq, dicFrom(7.8, alk))).toBeCloseTo(7.5, 3);
    expect(acidEqToReachPh(7.8, alk, 7.2)!).toBeGreaterThan(eq);
    expect(acidEqToReachPh(7.4, alk, 7.5)).toBeNull();
  });
  it('soda ash dose lands on the target pH', () => {
    const alk = 80 / 50000;
    const dic = dicFrom(7.0, alk);
    const mol = sodaAshMolToReachPh(7.0, alk, 7.5)!;
    expect(solvePh(alk + 2 * mol, dic + mol)).toBeCloseTo(7.5, 3);
  });
});

describe('dose arithmetic', () => {
  it('liquid chlorine 12.5%: about 10.2 fl oz per ppm per 10,000 gal', () => {
    const s = step(recommendDosing(base({ readings: { fc: 2, cya: 30 } })), 'fc_up')!;
    expect(s.baseUnit).toBe('fl_oz');
    expect(s.amount).toBeCloseTo(10.2, 1);
    expect(s.assumed).toBe(true);
    expect(s.logTarget).toBe('Raise chlorine');
  });
  it('scales with volume', () => {
    const a = step(
      recommendDosing(base({ readings: { fc: 2, cya: 30 }, volumeGal: 20000 })),
      'fc_up',
    )!.amount!;
    expect(a).toBeCloseTo(20.5, 1);
  });
  it('cal-hypo 67%: about 2 oz per ppm per 10,000 gal, with calcium side effect', () => {
    const s = step(
      recommendDosing(base({ readings: { fc: 2, cya: 30 } }), {
        chlorine: { chem: 'calcium_hypochlorite', strengthPct: 67 },
      }),
      'fc_up',
    )!;
    expect(s.baseUnit).toBe('oz');
    expect(s.amount).toBeCloseTo(1.99, 1);
    expect(s.assumed).toBe(false);
    expect(s.notes.join(' ')).toMatch(/calcium hardness/);
  });
  it('lowering alkalinity by 10 ppm takes about 25.6 fl oz of 31.45% acid per 10,000 gal', () => {
    const s = step(recommendDosing(base({ readings: { ta: 130, ph: 7.5 } })), 'ta_down')!;
    expect(s.amount).toBeCloseTo(25.6, 0);
    expect(s.partial).toBe(true); // 30 ppm needed, capped at 10 per application
    expect(s.expectedPh).toBeLessThan(7.5);
  });
  it('baking soda: raising alkalinity 20 ppm per 10,000 gal is about 1.9 lb (capped step)', () => {
    const s = step(recommendDosing(base({ readings: { ta: 60, ph: 7.5 } })), 'ta_up')!;
    expect(s.baseUnit).toBe('oz');
    expect(s.amount! / 16).toBeCloseTo((0.99 * 1.5) / 0.99, 0); // ~1.67 lb for 20 ppm
    expect(s.partial).toBe(true);
  });
  it('converts base doses to product units, and refuses incompatible ones', () => {
    expect(convertDose(32, 'fl_oz', 'qt')).toBeCloseTo(1, 6);
    expect(convertDose(128, 'fl_oz', 'gal')).toBeCloseTo(1, 6);
    expect(convertDose(16, 'oz', 'lb')).toBeCloseTo(1, 6);
    expect(convertDose(1, 'oz', 'g')).toBeCloseTo(28.3495, 3);
    expect(convertDose(1, 'fl_oz', 'lb')).toBeNull();
    expect(convertDose(1, 'oz', 'each')).toBeNull();
    expect(describeDose(10.24, 'fl_oz')).toBe('10.2 fl oz (303 mL)');
    expect(describeDose(0.5, 'oz')).toBe('14 g');
  });
});

describe('recommendation rules', () => {
  it('stays quiet when everything is in range', () => {
    expect(
      recommendDosing(base({ readings: { fc: 3, tc: 3.1, ph: 7.5, ta: 100, cya: 40, ch: 300 } })),
    ).toEqual([]);
  });
  it('asks for volume instead of guessing amounts', () => {
    const s = recommendDosing(base({ readings: { fc: 0.7 }, volumeGal: null }));
    expect(s.map((x) => x.id)).toEqual(['needs_volume']);
    expect(s[0].amount).toBeNull();
  });
  it('asks for alkalinity before dosing pH', () => {
    const s = recommendDosing(base({ readings: { ph: 8.0 } }));
    expect(s.map((x) => x.id)).toEqual(['needs_ta']);
  });
  it('lowers high pH with acid and raises low pH with soda ash', () => {
    const down = step(
      recommendDosing(base({ readings: { ph: 7.9, ta: 90, cya: 30 } })),
      'ph_down',
    )!;
    expect(down.logTarget).toBe('Lower pH');
    expect(down.amount).toBeGreaterThan(0);
    expect(down.amount).toBeLessThan(30);
    const up = step(recommendDosing(base({ readings: { ph: 7.0, ta: 90 } })), 'ph_up')!;
    expect(up.logTarget).toBe('Raise pH');
    expect(up.notes.join(' ')).toMatch(/raises total alkalinity/);
  });
  it('fixes alkalinity first and defers a non-critical pH dose', () => {
    const s = recommendDosing(base({ readings: { ta: 60, ph: 7.9 } }));
    expect(s.map((x) => x.id)).toEqual(['ta_up', 'ph_wait']);
  });
  it('does not add acid for high alkalinity when pH is already low', () => {
    const s = recommendDosing(base({ readings: { ta: 150, ph: 7.0 } }));
    expect(s.map((x) => x.id)).toContain('ta_hold');
    expect(s.some((x) => x.kind === 'lower_ta')).toBe(false);
  });
  it('orders chemical steps: alkalinity, pH, other, sanitizer', () => {
    const s = recommendDosing(base({ readings: { ta: 70, ph: 6.6, fc: 0.7, ch: 150 } }));
    const chem = s.filter((x) => x.order > 0).map((x) => x.id);
    expect(chem.indexOf('ta_up')).toBeLessThan(chem.indexOf('ph_up'));
    expect(chem.indexOf('ph_up')).toBeLessThan(chem.indexOf('ch_up'));
    expect(chem.indexOf('ch_up')).toBeLessThan(chem.indexOf('fc_up'));
    expect(s.filter((x) => x.order > 0).map((x) => x.order)).toEqual(chem.map((_, i) => i + 1));
  });
  it('puts critically low chlorine first', () => {
    const s = recommendDosing(base({ readings: { fc: 0.2, ta: 70, ph: 7.5 } }));
    expect(s.find((x) => x.order === 1)!.id).toBe('fc_up');
    expect(s[0].severity).toBe('critical');
  });
  it('breaks chloramines with 10x combined chlorine', () => {
    expect(breakpointLevel(1.2)).toBe(12);
    expect(breakpointLevel(0.5)).toBe(5);
    const s = step(recommendDosing(base({ readings: { fc: 2, tc: 3.2, ph: 7.5 } })), 'shock')!;
    expect(s.title).toContain('12 ppm');
    expect(s.logTarget).toBe('Shock / oxidize');
    expect(s.amount).toBeCloseTo(102.4, 0);
  });
  it('treats green water as a SLAM at 40% of CYA (min 10 ppm) and assumes no residual', () => {
    expect(slamLevel(40)).toBe(16);
    expect(slamLevel(10)).toBe(10);
    const s = step(recommendDosing(base({ readings: { cya: 40 }, clarity: 'Green' })), 'slam')!;
    expect(s.logTarget).toBe('Algae treatment');
    expect(s.notes.join(' ')).toMatch(/assumes none/);
    expect(s.order).toBe(1);
  });
  it('caps a single chlorine addition at 20 ppm and says so', () => {
    const s = step(
      recommendDosing(base({ readings: { cya: 100, fc: 0 }, clarity: 'Green' })),
      'slam',
    )!;
    expect(s.partial).toBe(true);
    expect(s.amount).toBeCloseTo(204.8, 0);
  });
  it('treats free chlorine below 7.5% of the stabilizer as low even when the flat range says ok', () => {
    expect(evaluateWater({ fc: 2, cya: 40 }).statuses.fc).toBe('ok');
    expect(step(recommendDosing(base({ readings: { fc: 2, cya: 40 } })), 'fc_up')!.detail).toMatch(
      /at or above 3 ppm/,
    );
    expect(
      step(recommendDosing(base({ readings: { fc: 3.5, cya: 40 } })), 'fc_up'),
    ).toBeUndefined();
  });
  it('raises chlorine target with stabilizer and has a spa target', () => {
    expect(targetFc('pool', 30)).toBe(3);
    expect(targetFc('pool', 75)).toBe(6);
    expect(targetFc('spa')).toBe(4);
  });
  it('recommends dilution (not chemicals) for high stabilizer, capped per visit', () => {
    const s = step(recommendDosing(base({ readings: { cya: 120 } })), 'dilute')!;
    expect(s.amount).toBeNull();
    expect(s.drainPercent).toBe(33);
    expect(s.partial).toBe(true);
  });
  it('only dosing salt for salt-water systems', () => {
    expect(step(recommendDosing(base({ readings: { salt: 2000 } })), 'salt_up')).toBeUndefined();
    const s = step(
      recommendDosing(base({ readings: { salt: 2000 }, sanitizer: 'salt' })),
      'salt_up',
    )!;
    expect(s.amount! / 16).toBeGreaterThan(50); // pounds for +1000 ppm (capped) in 10,000 gal
  });
  it('gives bromine guidance without inventing amounts', () => {
    const s = recommendDosing(
      base({ body: 'spa', sanitizer: 'bromine', volumeGal: 400, readings: { br: 2.5, ph: 7.5 } }),
    );
    const b = step(s, 'br_low')!;
    expect(b.amount).toBeNull();
    expect(b.logTarget).toBe('Raise bromine');
    expect(s.some((x) => x.id === 'fc_up')).toBe(false);
  });
  it('warns about spa heat', () => {
    const s = recommendDosing(
      base({ body: 'spa', volumeGal: 400, readings: { temp_f: 107, ph: 7.5 } }),
    );
    expect(s[0]).toMatchObject({ id: 'heat', severity: 'critical' });
  });
  it('uses the registered product strength and falls back for implausible values', () => {
    const at10 = step(
      recommendDosing(base({ readings: { fc: 2, cya: 30 } }), {
        chlorine: { chem: 'liquid_chlorine', strengthPct: 10 },
      }),
      'fc_up',
    )!;
    expect(at10.amount).toBeCloseTo(12.8, 1);
    const silly = step(
      recommendDosing(base({ readings: { fc: 2, cya: 30 } }), {
        chlorine: { chem: 'liquid_chlorine', strengthPct: 90 },
      }),
      'fc_up',
    )!;
    expect(silly.choice!.strengthPct).toBe(DEFAULT_CHOICES.chlorine.strengthPct);
  });
  it('never produces NaN or negative amounts across a sweep of readings', () => {
    for (const ph of [6.4, 7.0, 7.5, 8.0, 8.6])
      for (const ta of [20, 60, 100, 160, 260])
        for (const cya of [0, 40, 130])
          for (const fc of [0, 2, 12])
            for (const body of ['pool', 'spa'] as const) {
              const out = recommendDosing(
                base({
                  body,
                  readings: { ph, ta, cya, fc, tc: fc + 0.8, ch: 120, salt: 2500 },
                  sanitizer: 'salt',
                }),
              );
              for (const s of out) {
                if (s.amount !== null) expect(Number.isFinite(s.amount) && s.amount > 0).toBe(true);
                expect(s.order).toBeGreaterThanOrEqual(0);
              }
            }
  });
});

describe('products and log entries', () => {
  const products = [
    {
      id: 'a',
      name: 'Bleach',
      unit: 'gal' as const,
      chem_key: 'liquid_chlorine',
      strength_pct: 10,
      archived_at: null,
    },
    {
      id: 'b',
      name: 'Old acid',
      unit: 'fl_oz' as const,
      chem_key: 'muriatic_acid',
      strength_pct: 31.45,
      archived_at: '2027-01-01',
    },
    {
      id: 'c',
      name: 'Algaecide',
      unit: 'fl_oz' as const,
      chem_key: null,
      strength_pct: null,
      archived_at: null,
    },
    {
      id: 'd',
      name: 'Acid',
      unit: 'qt' as const,
      chem_key: 'muriatic_acid',
      strength_pct: 31.45,
      archived_at: null,
    },
  ];
  it('matches register products to roles, skipping archived and unmapped ones', () => {
    expect(productsForRole('chlorine', products).map((p) => p.product.id)).toEqual(['a']);
    expect(productsForRole('ph_down', products).map((p) => p.product.id)).toEqual(['d']);
    expect(productsForRole('salt', products)).toEqual([]);
  });
  it('builds a dosing entry the server schema accepts', () => {
    const logType = getLogType(POOL_SERVICE_PACK, 'dosing')!;
    const choices = { chlorine: productsForRole('chlorine', products)[0].choice };
    const s = step(recommendDosing(base({ readings: { fc: 2, cya: 30 } }), choices), 'fc_up')!;
    expect(doseForProduct(s, products[0])).toBeCloseTo(0.1, 2); // 12.8 fl oz as gallons
    const data = dosingEntryData(s, products[0])!;
    expect(data).toMatchObject({
      amount_unit: 'gal',
      target: 'Raise chlorine',
      from_recommendation: true,
    });
    expect(validateLogData(logType, cleanLogData(data))).toEqual([]);
  });
  it('rejects a product unit that cannot hold the dose', () => {
    const s = step(recommendDosing(base({ readings: { fc: 2, cya: 30 } })), 'fc_up')!;
    expect(dosingEntryData(s, { unit: 'lb' })).toBeNull();
    expect(dosingEntryData(s, { unit: 'each' })).toBeNull();
  });
  it('every dosing purpose a step can use exists in the pack schema', () => {
    const logType = getLogType(POOL_SERVICE_PACK, 'dosing')!;
    const options = logType.fields.find((f) => f.key === 'target')!.options!;
    const samples: Array<[Partial<DosingInput>, string]> = [
      [{ readings: { fc: 0.7 } }, 'Raise chlorine'],
      [{ readings: { fc: 2, tc: 3.5 } }, 'Shock / oxidize'],
      [{ readings: { fc: 0 }, clarity: 'Green' }, 'Algae treatment'],
      [{ readings: { ph: 7.9, ta: 90 } }, 'Lower pH'],
      [{ readings: { ph: 7.0, ta: 90 } }, 'Raise pH'],
      [{ readings: { ta: 60, ph: 7.5 } }, 'Raise alkalinity'],
      [{ readings: { ta: 140, ph: 7.5 } }, 'Lower alkalinity'],
      [{ readings: { cya: 10 } }, 'Raise stabilizer'],
      [{ readings: { ch: 120 } }, 'Raise calcium'],
      [{ readings: { salt: 2000 }, sanitizer: 'salt' }, 'Add salt'],
      [{ readings: { br: 1 }, sanitizer: 'bromine' }, 'Raise bromine'],
    ];
    for (const [input, target] of samples) {
      const out = recommendDosing(base(input)).filter((x) => x.logTarget);
      expect(out.map((x) => x.logTarget)).toContain(target);
      expect(options).toContain(target);
    }
  });
  it('builds a reading entry the server schema accepts, dropping blanks', () => {
    const logType = getLogType(POOL_SERVICE_PACK, 'chemistry_reading')!;
    const data = readingEntryData({
      body: 'spa',
      sanitizer: 'Bromine',
      volumeGal: 399.6,
      readings: { br: 4.5, ph: 7.5, temp_f: 101, fc: undefined },
      clarity: 'Clear',
    });
    expect(data).toEqual({
      water_body: WATER_BODY_LABELS.spa,
      sanitizer: 'Bromine',
      volume_gal: 400,
      br: 4.5,
      ph: 7.5,
      temp_f: 101,
      clarity: 'Clear',
    });
    expect(validateLogData(logType, cleanLogData(data))).toEqual([]);
    expect(validateLogData(logType, { water_body: 'Pool' })).toContain(
      'Enter at least one reading',
    );
  });
});

describe('history + trends', () => {
  const row = (
    at: string,
    data: Record<string, unknown>,
    extra: Partial<LogRowLike> = {},
  ): LogRowLike => ({ entry_type: 'chemistry_reading', performed_at: at, data, ...extra });
  const rows = [
    row('2027-03-03T10:00:00Z', {
      ph: 7.6,
      water_body: 'Spa / hot tub',
      volume_gal: 400,
      sanitizer: 'Bromine',
    }),
    row('2027-03-01T10:00:00Z', { ph: 7.2, volume_gal: 15000 }),
    row(
      '2027-03-02T10:00:00Z',
      { ph: 9, water_body: 'Pool' },
      { voided_at: '2027-03-02T12:00:00Z' },
    ),
    { entry_type: 'dosing', performed_at: '2027-03-04T10:00:00Z', data: { ph: 1 } },
  ];
  it('returns non-voided readings oldest first', () => {
    expect(seriesFor(rows, 'ph').map((p) => p.value)).toEqual([7.2, 7.6]);
  });
  it('carries the profile over from the latest reading that has it', () => {
    expect(defaultsFromHistory(rows)).toEqual({
      body: 'spa',
      volumeGal: 400,
      sanitizer: 'Bromine',
    });
    expect(defaultsFromHistory([])).toEqual({});
  });
  it('reports a trend direction', () => {
    expect(trendDirection([7.2])).toBeNull();
    expect(trendDirection([7.2, 7.4, 7.8])).toBe('up');
    expect(trendDirection([7.8, 7.6, 7.2])).toBe('down');
    expect(trendDirection([7.5, 7.5, 7.5])).toBe('flat');
  });
  it('builds a sparkline that keeps the target band in view', () => {
    expect(sparkline([], 100, 40)).toEqual({ path: '', last: null, band: null });
    const s = sparkline([7.4, 7.6], 100, 40, { min: 7.2, max: 7.8 });
    expect(s.path.startsWith('M')).toBe(true);
    expect(s.band!.y1).toBeLessThan(s.band!.y2);
    expect(s.band!.y1).toBeGreaterThanOrEqual(0);
    expect(s.band!.y2).toBeLessThanOrEqual(40);
  });
});

describe('manifest <-> database', () => {
  const sql: string = migrationSql;
  const specFor = (entry: string) => {
    const m = sql.match(
      new RegExp(`'pool_service', '${entry}'[\\s\\S]*?'(\\{"fields".*?\\})'::jsonb`),
    );
    expect(m).not.toBeNull();
    return JSON.parse((m as RegExpMatchArray)[1]);
  };
  const manifestSpec = (key: string) => {
    const t = getLogType(POOL_SERVICE_PACK, key)!;
    return {
      fields: t.fields.map((f) => ({
        key: f.key,
        type: f.type,
        required: !!f.required,
        ...(f.min !== undefined ? { min: f.min } : {}),
        ...(f.max !== undefined ? { max: f.max } : {}),
        ...(f.options ? { options: f.options } : {}),
      })),
      at_least_one_of: t.atLeastOneOf ?? [],
    };
  };
  it('migration seeds exactly the specs the manifest declares', () => {
    expect(specFor('chemistry_reading')).toEqual(manifestSpec('chemistry_reading'));
    expect(specFor('dosing')).toEqual(manifestSpec('dosing'));
  });
  it('migration chemical keys and strength bands match the catalogue', () => {
    for (const id of CHEM_IDS) {
      expect(sql).toContain(`'${id}'`);
      const d = CHEMICALS[id];
      const m = sql.match(new RegExp(`\\('${id}', (\\d+)(?:::numeric)?, (\\d+)(?:::numeric)?\\)`));
      expect(m, id).not.toBeNull();
      expect([Number(m![1]), Number(m![2])]).toEqual([d.minStrengthPct, d.maxStrengthPct]);
      expect(d.defaultStrengthPct).toBeGreaterThanOrEqual(d.minStrengthPct);
      expect(d.defaultStrengthPct).toBeLessThanOrEqual(d.maxStrengthPct);
    }
  });
  it('sanitizer and water-body option lists agree with the schema', () => {
    const f = getLogType(POOL_SERVICE_PACK, 'chemistry_reading')!.fields;
    expect(f.find((x) => x.key === 'sanitizer')!.options).toEqual([...SANITIZER_OPTIONS]);
    expect(f.find((x) => x.key === 'water_body')!.options).toEqual(
      Object.values(WATER_BODY_LABELS),
    );
  });
});
