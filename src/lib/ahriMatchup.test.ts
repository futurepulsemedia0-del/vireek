import { describe, expect, it } from 'vitest';
import {
  coolingCapacityAtDesign,
  evaluateMatchup,
  heatPumpCapacityAt,
  matchupTitle,
  normalizeStaging,
  normalizeSystemType,
  parseCsv,
  parseMatchupCsv,
  parseMatchupRecord,
  parseMatchupRow,
  rankMatchups,
  regionalMinimums,
  type AhriMatchup,
  type MatchupContext,
} from './ahriMatchup';

const load = {
  cooling: { sensibleBtuh: 27000, latentBtuh: 5000, totalBtuh: 32000, sensibleHeatRatio: 0.84, tons: 2.67 },
  heating: { totalBtuh: 40000 },
};
const ctx = (region: 'north' | 'south' | 'southwest' = 'south'): MatchupContext => ({ load, outdoorSummerDb: 95, outdoorWinterDb: 17, region });

function m(over: Partial<AhriMatchup> = {}): AhriMatchup {
  return {
    id: 'm1', ahri_ref_number: '1001', manufacturer: 'Acme', brand: null, system_type: 'split_hp', staging: 'single',
    outdoor_model: 'OUT-36', indoor_model: 'COIL-36', furnace_model: null, cooling_btuh: 34000, seer2: 15.2, eer2: 11.5,
    hspf2: 8.1, heating_47_btuh: 34000, heating_17_btuh: 21000, furnace_output_btuh: null, shr: 0.8, airflow_cfm: 1200,
    refrigerant: 'R-454B', sell_price_cents: 900000, ahri_status: 'verified', verified_at: '2026-10-01T00:00:00Z',
    active: true, notes: null, created_at: '', updated_at: '', ...over,
  };
}

describe('capacity helpers', () => {
  it('derates cooling above 95F and never boosts below it', () => {
    expect(coolingCapacityAtDesign(36000, 95)).toBe(36000);
    expect(coolingCapacityAtDesign(36000, 85)).toBe(36000);
    expect(coolingCapacityAtDesign(36000, 105)).toBeCloseTo(33840, 0);
  });
  it('interpolates heat pump capacity between 47F and 17F and extrapolates below', () => {
    expect(heatPumpCapacityAt(36000, 21000, 47)).toBe(36000);
    expect(heatPumpCapacityAt(36000, 21000, 17)).toBe(21000);
    expect(heatPumpCapacityAt(36000, 21000, 32)).toBe(28500);
    expect(heatPumpCapacityAt(36000, 21000, 2)).toBe(13500);
    expect(heatPumpCapacityAt(36000, 1000, -20)).toBe(0);
  });
});

describe('regionalMinimums', () => {
  it('covers each region and type', () => {
    expect(regionalMinimums('split_ac', 'north', 36000)).toEqual({ seer2: 13.4, eer2: null, hspf2: null });
    expect(regionalMinimums('split_ac', 'south', 36000).seer2).toBe(14.3);
    expect(regionalMinimums('split_ac', 'south', 48000).seer2).toBe(13.8);
    expect(regionalMinimums('split_ac', 'southwest', 36000).eer2).toBe(11.7);
    expect(regionalMinimums('split_hp', 'north', 36000)).toEqual({ seer2: 14.3, eer2: null, hspf2: 7.5 });
    expect(regionalMinimums('packaged_hp', 'south', 36000).hspf2).toBe(6.7);
    expect(regionalMinimums('packaged_ac', 'southwest', 36000).eer2).toBe(10.6);
  });
});

describe('evaluateMatchup', () => {
  it('passes a well sized, efficient, verified heat pump and reports backup heat need', () => {
    const f = evaluateMatchup(m(), ctx());
    expect(f.coolingStatus).toBe('ideal');
    expect(f.passes).toBe(true);
    expect(f.verified).toBe(true);
    expect(f.heating.status).toBe('needs_backup');
    expect(f.heating.backupBtuh).toBe(19000);
    expect(f.heating.backupKw).toBeCloseTo(5.6, 1);
    expect(f.score).toBeGreaterThan(90);
  });

  it('fails an undersized system', () => {
    const f = evaluateMatchup(m({ cooling_btuh: 24000 }), ctx());
    expect(f.coolingStatus).toBe('undersized');
    expect(f.passes).toBe(false);
  });

  it('flags oversizing, and lets variable-speed run bigger than single-stage', () => {
    const big = { cooling_btuh: 40000 };
    expect(evaluateMatchup(m(big), ctx()).coolingStatus).toBe('oversized');
    expect(evaluateMatchup(m({ ...big, staging: 'variable' }), ctx()).passes).toBe(true);
  });

  it('fails below the regional efficiency minimum', () => {
    const f = evaluateMatchup(m({ system_type: 'split_ac', hspf2: null, seer2: 13.5 }), ctx('south'));
    expect(f.efficiency.meetsSeer2).toBe(false);
    expect(f.passes).toBe(false);
    expect(f.issues.join(' ')).toMatch(/below the 14.3 minimum/);
  });

  it('asks for EER2 in the Southwest instead of failing silently', () => {
    const f = evaluateMatchup(m({ system_type: 'split_ac', hspf2: null, eer2: null, seer2: 15 }), ctx('southwest'));
    expect(f.efficiency.meetsEer2).toBeNull();
    expect(f.issues.join(' ')).toMatch(/Add the EER2/);
  });

  it('requires heat pump capacities to judge heating', () => {
    const f = evaluateMatchup(m({ heating_47_btuh: null, heating_17_btuh: null }), ctx());
    expect(f.heating.status).toBe('unknown');
    expect(f.passes).toBe(true);
  });

  it('judges furnace output against 100-140% of the heating load', () => {
    const base = { system_type: 'ac_furnace' as const, hspf2: null, heating_47_btuh: null, heating_17_btuh: null };
    expect(evaluateMatchup(m({ ...base, furnace_output_btuh: 36000 }), ctx()).passes).toBe(false);
    expect(evaluateMatchup(m({ ...base, furnace_output_btuh: 48000 }), ctx()).heating.status).toBe('ok');
    expect(evaluateMatchup(m({ ...base, furnace_output_btuh: 70000 }), ctx()).heating.status).toBe('oversized');
  });

  it('assumes and discloses a sensible heat ratio when none is on file', () => {
    const f = evaluateMatchup(m({ shr: null }), ctx());
    expect(f.issues.join(' ')).toMatch(/0.75 was assumed/);
  });

  it('marks unverified combinations', () => {
    const f = evaluateMatchup(m({ ahri_status: 'unverified' }), ctx());
    expect(f.verified).toBe(false);
    expect(f.issues.join(' ')).toMatch(/Not yet verified/);
  });
});

describe('rankMatchups', () => {
  it('puts passing systems first, ignores archived ones, and breaks ties by price', () => {
    const list = [
      m({ id: 'under', ahri_ref_number: '1', cooling_btuh: 24000 }),
      m({ id: 'pricey', ahri_ref_number: '2', sell_price_cents: 990000 }),
      m({ id: 'cheap', ahri_ref_number: '3', sell_price_cents: 850000 }),
      m({ id: 'gone', ahri_ref_number: '4', active: false }),
    ];
    const ranked = rankMatchups(list, ctx());
    expect(ranked.map((r) => r.matchup.id)).toEqual(['cheap', 'pricey', 'under']);
    expect(ranked[2].passes).toBe(false);
  });
});

describe('csv import', () => {
  it('parses quotes, escaped quotes, CRLF, BOM and tabs', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x,1","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  const header = 'AHRI Ref Number,Manufacturer,System Type,Staging,Outdoor Model,Indoor Model,Tons,SEER2,HSPF2,Heating 47,Heating 17,Price';

  it('maps header aliases, converts tons and dollars, and reports bad rows by line', () => {
    const csv = [
      header,
      '1111,Acme,split hp,variable,X1,Y1,3,17.5,8.8,36000,22000,"9,800"',
      '2222,Acme,split ac,single,"Z,2",C2,3,15,,,,7000',
      '3333,Acme,split ac,single,Z3,C3,3,15,,,,abc',
      '1111,Acme,split ac,single,Z4,C4,3,15,,,,100',
      '5555,Acme,mystery,single,Z5,C5,3,15,,,,100',
    ].join('\n');
    const p = parseMatchupCsv(csv);
    expect(p.fatal).toBeNull();
    expect(p.rows.map((r) => r.ahri_ref_number)).toEqual(['1111', '2222']);
    expect(p.rows[0].cooling_btuh).toBe(36000);
    expect(p.rows[0].sell_price_cents).toBe(980000);
    expect(p.rows[1].outdoor_model).toBe('Z,2');
    expect(p.rejected.map((r) => r.line)).toEqual([4, 5, 6]);
    expect(p.rejected[1].reason).toMatch(/Duplicate/);
    expect(p.rejected[2].reason).toMatch(/System type/);
  });

  it('fails fast on a missing column or an empty paste', () => {
    expect(parseMatchupCsv('only a header').fatal).toMatch(/header row/);
    expect(parseMatchupCsv('Manufacturer,SEER2\nAcme,15').fatal).toMatch(/ahri ref number/);
  });
});

describe('parseMatchupRecord', () => {
  const ok = { ahri_ref_number: '123', manufacturer: 'A', outdoor_model: 'O', system_type: 'split_ac', staging: '', cooling_btuh: 36000, seer2: 15 };
  it('accepts a minimal record with defaults', () => {
    const r = parseMatchupRecord(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.staging).toBe('single');
  });
  it('rejects bad values with a reason', () => {
    const bad = (over: Record<string, unknown>) => {
      const r = parseMatchupRecord({ ...ok, ...over });
      return r.ok ? '' : r.reason;
    };
    expect(bad({ ahri_ref_number: 'bad number!' })).toMatch(/AHRI reference/);
    expect(bad({ cooling_btuh: 500 })).toMatch(/Cooling capacity/);
    expect(bad({ seer2: 99 })).toMatch(/SEER2/);
    expect(bad({ system_type: 'split_hp' })).toMatch(/HSPF2/);
    expect(bad({ shr: 2 })).toMatch(/Sensible heat ratio/);
    expect(bad({ seer2: 'abc' })).toMatch(/not a number/);
  });
  it('normalises enums', () => {
    expect(normalizeSystemType('Heat Pump')).toBe('split_hp');
    expect(normalizeSystemType('nope')).toBeNull();
    expect(normalizeStaging('Variable-Speed')).toBe('variable');
    expect(normalizeStaging('Two Stage')).toBe('two_stage');
    expect(normalizeStaging('huh')).toBeNull();
  });
});

describe('parseMatchupRow', () => {
  it('rebuilds a row from DB JSON (numeric strings included) and drops junk', () => {
    const row = parseMatchupRow({ id: 'x', ahri_ref_number: '9', manufacturer: 'A', outdoor_model: 'O', system_type: 'split_ac', staging: 'single', cooling_btuh: '36000', seer2: '15.50', ahri_status: 'verified' });
    expect(row?.cooling_btuh).toBe(36000);
    expect(row?.seer2).toBe(15.5);
    expect(row?.ahri_status).toBe('verified');
    expect(parseMatchupRow({ id: 'x' })).toBeNull();
    expect(parseMatchupRow(null)).toBeNull();
  });
  it('titles a matchup', () => {
    expect(matchupTitle(m())).toBe('Acme 2.8-ton split heat pump');
  });
});
