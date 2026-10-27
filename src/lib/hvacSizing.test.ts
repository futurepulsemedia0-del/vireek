import { describe, expect, it } from 'vitest';
import {
  airDensityRatio,
  ashrae622Cfm,
  computeDuctDesign,
  computeLoad,
  defaultDuctInputs,
  defaultLoadInputs,
  equivalentDiameterIn,
  nextRoundSizeIn,
  rectangularOptions,
  roundDiameterIn,
  roundDuctVelocityFpm,
  sanitizeDuctInputs,
  sanitizeLoadInputs,
  validateDuctInputs,
  validateLoadInputs,
  type DuctInputs,
} from './hvacSizing';

const rooms = [
  { id: 'a', name: 'Living', cfm: null, loadBtuh: 9000, runLengthFt: 25 },
  { id: 'b', name: 'Primary bedroom', cfm: null, loadBtuh: 6000, runLengthFt: 40 },
  { id: 'c', name: 'Kitchen', cfm: null, loadBtuh: 5000, runLengthFt: 15 },
];

describe('computeLoad', () => {
  it('gives a plausible whole-house load for the default home', () => {
    const r = computeLoad(defaultLoadInputs());
    expect(r.cooling.totalBtuh).toBeGreaterThan(15000);
    expect(r.cooling.totalBtuh).toBeLessThan(40000);
    expect(r.heating.totalBtuh).toBeGreaterThan(20000);
    expect(r.cooling.sensibleBtuh + r.cooling.latentBtuh).toBe(r.cooling.totalBtuh);
    expect(r.cooling.sensibleHeatRatio).toBeGreaterThan(0.6);
    expect(r.cooling.sensibleHeatRatio).toBeLessThanOrEqual(1);
    expect(r.warnings).toEqual([]);
  });

  it('raises the cooling load for a hotter, more humid, leakier house', () => {
    const base = computeLoad(defaultLoadInputs());
    const worse = computeLoad({ ...defaultLoadInputs(), outdoorSummerDb: 100, humidity: 'humid', airTightness: 'loose', ductLocation: 'attic_leaky' });
    expect(worse.cooling.totalBtuh).toBeGreaterThan(base.cooling.totalBtuh * 1.2);
    expect(worse.cooling.latentBtuh).toBeGreaterThan(base.cooling.latentBtuh);
  });

  it('raises the heating load in a colder climate and drops it with better insulation', () => {
    const base = computeLoad(defaultLoadInputs());
    expect(computeLoad({ ...defaultLoadInputs(), outdoorWinterDb: -5 }).heating.totalBtuh).toBeGreaterThan(base.heating.totalBtuh);
    expect(computeLoad({ ...defaultLoadInputs(), wallR: 25, ceilingR: 60 }).heating.totalBtuh).toBeLessThan(base.heating.totalBtuh);
  });

  it('puts more solar gain on west glass than north glass', () => {
    const none = { n: 0, e: 0, s: 0, w: 0 };
    const west = computeLoad({ ...defaultLoadInputs(), windowAreaSqft: { ...none, w: 100 } }).rows.find((x) => x.key === 'solar')!;
    const north = computeLoad({ ...defaultLoadInputs(), windowAreaSqft: { ...none, n: 100 } }).rows.find((x) => x.key === 'solar')!;
    expect(west.coolingBtuh).toBeGreaterThan(north.coolingBtuh * 3);
  });

  it('adds no duct loss when ducts are inside the conditioned space', () => {
    const r = computeLoad({ ...defaultLoadInputs(), ductLocation: 'conditioned' });
    const ducts = r.rows.find((x) => x.key === 'ducts')!;
    expect(ducts.coolingBtuh).toBe(0);
    expect(ducts.heatingBtuh).toBe(0);
  });

  it('cuts ventilation load with an ERV', () => {
    const plain = computeLoad({ ...defaultLoadInputs(), ventilationCfm: 80, humidity: 'humid' });
    const erv = computeLoad({ ...defaultLoadInputs(), ventilationCfm: 80, humidity: 'humid', ventilationRecovery: 'erv' });
    const rowOf = (x: typeof plain) => x.rows.find((r) => r.key === 'ventilation')!;
    expect(rowOf(erv).coolingBtuh).toBeLessThan(rowOf(plain).coolingBtuh);
    expect(rowOf(erv).heatingBtuh).toBeLessThan(rowOf(plain).heatingBtuh);
  });

  it('reports row totals that add up to the headline numbers (within rounding)', () => {
    const r = computeLoad(defaultLoadInputs());
    const coolSum = r.rows.reduce((a, x) => a + x.coolingBtuh, 0);
    const heatSum = r.rows.reduce((a, x) => a + x.heatingBtuh, 0);
    expect(Math.abs(coolSum - r.cooling.totalBtuh)).toBeLessThanOrEqual(r.rows.length);
    expect(Math.abs(heatSum - r.heating.totalBtuh)).toBeLessThanOrEqual(r.rows.length);
  });

  it('warns about glass-heavy walls', () => {
    const r = computeLoad({ ...defaultLoadInputs(), windowAreaSqft: { n: 200, e: 200, s: 200, w: 200 } });
    expect(r.warnings.join(' ')).toMatch(/30% of the wall area/);
  });

  it('throws on invalid inputs instead of returning nonsense', () => {
    expect(() => computeLoad({ ...defaultLoadInputs(), conditionedAreaSqft: Number.NaN })).toThrow(RangeError);
  });
});

describe('validateLoadInputs', () => {
  it('accepts the defaults', () => {
    expect(validateLoadInputs(defaultLoadInputs())).toEqual({});
  });
  it('flags out-of-range and impossible temperatures', () => {
    const e = validateLoadInputs({ ...defaultLoadInputs(), outdoorSummerDb: 70, indoorSummerDb: 75, ceilingHeightFt: 40, wallR: 0 });
    expect(e.outdoorSummerDb).toMatch(/higher than the indoor/);
    expect(e.ceilingHeightFt).toBeDefined();
    expect(e.wallR).toBeDefined();
  });
  it('flags a blank (NaN) field', () => {
    expect(validateLoadInputs({ ...defaultLoadInputs(), occupants: Number.NaN }).occupants).toBeDefined();
  });
});

describe('helpers', () => {
  it('density ratio is 1 at sea level and lower at altitude', () => {
    expect(airDensityRatio(0)).toBeCloseTo(1, 5);
    expect(airDensityRatio(5000)).toBeLessThan(0.87);
  });
  it('ASHRAE 62.2 airflow', () => {
    expect(ashrae622Cfm(2000, 3)).toBe(90);
    expect(ashrae622Cfm(0, 3)).toBe(0);
  });
});

describe('duct math', () => {
  it('sizes 100 cfm at 0.1 in/100ft to about 6 in.', () => {
    expect(roundDiameterIn(100, 0.1)).toBeGreaterThan(5.5);
    expect(roundDiameterIn(100, 0.1)).toBeLessThan(6.2);
  });
  it('gets bigger as friction rate drops or airflow rises', () => {
    expect(roundDiameterIn(100, 0.05)).toBeGreaterThan(roundDiameterIn(100, 0.1));
    expect(roundDiameterIn(200, 0.1)).toBeGreaterThan(roundDiameterIn(100, 0.1));
  });
  it('velocity of 1,000 cfm in a 16 in. duct is about 717 fpm', () => {
    expect(roundDuctVelocityFpm(1000, 16)).toBeCloseTo(716.2, 0);
  });
  it('rounds up to standard sizes', () => {
    expect(nextRoundSizeIn(5.1)).toBe(6);
    expect(nextRoundSizeIn(10)).toBe(10);
    expect(nextRoundSizeIn(10.1)).toBe(12);
    expect(nextRoundSizeIn(99)).toBe(30);
  });
  it('rectangular options are at least as large as the round duct and within 4:1', () => {
    const opts = rectangularOptions(10);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(equivalentDiameterIn(o.heightIn, o.widthIn)).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(Math.max(o.heightIn, o.widthIn) / Math.min(o.heightIn, o.widthIn)).toBeLessThanOrEqual(4);
    }
  });
});

describe('computeDuctDesign', () => {
  const base = (): DuctInputs => ({ ...defaultDuctInputs(36000), rooms });

  it('shares system airflow across rooms by load and conserves it', () => {
    const r = computeDuctDesign(base());
    expect(r.totalCfm).toBe(1200);
    const total = r.branches.reduce((a, b) => a + b.cfm, 0);
    expect(Math.abs(total - 1200)).toBeLessThanOrEqual(r.branches.length);
    expect(r.branches[0].cfm).toBeGreaterThan(r.branches[2].cfm - 1);
  });

  it('keeps every branch at or under the velocity target', () => {
    const r = computeDuctDesign(base());
    for (const b of r.branches) expect(b.velocityFpm).toBeLessThanOrEqual(750);
    expect(r.supplyTrunk.velocityFpm).toBeLessThanOrEqual(900);
    expect(r.returnTrunk.velocityFpm).toBeLessThanOrEqual(700);
  });

  it('never goes below a 4 in. branch', () => {
    const r = computeDuctDesign({ ...base(), rooms: [{ id: 'x', name: 'Closet', cfm: 30, loadBtuh: null, runLengthFt: 10 }, ...rooms] });
    expect(r.branches[0].roundSizeIn).toBeGreaterThanOrEqual(4);
  });

  it('honours explicit room cfm and warns when it disagrees with the system airflow', () => {
    const r = computeDuctDesign({ ...base(), rooms: [{ id: 'a', name: 'Only room', cfm: 400, loadBtuh: null, runLengthFt: 20 }] });
    expect(r.branches[0].cfm).toBe(400);
    expect(r.warnings.join(' ')).toMatch(/differs from the 1,?200 cfm/);
  });

  it('warns about a very low friction rate on long paths', () => {
    const r = computeDuctDesign({ ...base(), trunkLengthFt: 150, returnLengthFt: 200, rooms: rooms.map((x) => ({ ...x, runLengthFt: 100 })) });
    expect(r.warnings.join(' ')).toMatch(/Friction rate is low/);
  });

  it('uses system airflow override when given', () => {
    expect(computeDuctDesign({ ...base(), totalCfm: 1000 }).totalCfm).toBe(1000);
  });

  it('validates rooms and pressure budget', () => {
    expect(validateDuctInputs({ ...base(), rooms: [] }).rooms).toBeDefined();
    expect(validateDuctInputs({ ...base(), componentLossesInWc: 0.6 }).componentLossesInWc).toMatch(/lower than/);
    const e = validateDuctInputs({ ...base(), rooms: [{ id: 'z', name: ' ', cfm: null, loadBtuh: null, runLengthFt: 0 }] });
    expect(e.room_0_name).toBeDefined();
    expect(e.room_0_flow).toBeDefined();
    expect(e.room_0_run).toBeDefined();
    expect(() => computeDuctDesign({ ...base(), rooms: [] })).toThrow(RangeError);
  });
});

describe('sanitizers', () => {
  it('fall back to defaults for junk', () => {
    expect(sanitizeLoadInputs(null)).toEqual(defaultLoadInputs());
    expect(sanitizeLoadInputs({ stories: 9, humidity: 'swampy', wallR: 'x' })).toEqual(defaultLoadInputs());
  });
  it('keep valid saved values and clamp room count', () => {
    expect(sanitizeLoadInputs({ wallR: 21, stories: 2 }).wallR).toBe(21);
    expect(sanitizeLoadInputs({ wallR: 21, stories: 2 }).stories).toBe(2);
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, name: 'R', cfm: 50, runLengthFt: 10 }));
    expect(sanitizeDuctInputs({ rooms: many }, 30000).rooms).toHaveLength(40);
    expect(sanitizeDuctInputs(undefined, 30000).coolingBtuh).toBe(30000);
  });
});
