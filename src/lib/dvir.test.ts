import { describe, it, expect } from 'vitest';
import {
  emptyAnswers,
  evaluateInspection,
  faultTitle,
  friendlyDispatchError,
  groupByCategory,
  isOdometerAnomaly,
  parseOdometer,
  photoRequired,
  slugifyKey,
  validateInspection,
  vehicleBlocked,
  type AnswerMap,
  type ChecklistItem,
} from './dvir';

const item = (key: string, over: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id: key, item_key: key, label: key.toUpperCase(), category: 'Safety', severity_if_defect: 'major',
  applies_to: 'both', requires_photo: false, sort_order: 10, active: true, ...over,
});

const ITEMS = [
  item('brakes', { severity_if_defect: 'out_of_service', sort_order: 1 }),
  item('horn', { severity_if_defect: 'minor', category: 'Visibility', sort_order: 2 }),
  item('lights', { requires_photo: true, category: 'Visibility', sort_order: 3 }),
];

const allPass = (): AnswerMap => {
  const a = emptyAnswers(ITEMS);
  for (const k of Object.keys(a)) a[k] = { ...a[k], result: 'pass' };
  return a;
};

const valid = (over: Partial<Parameters<typeof validateInspection>[0]> = {}) =>
  validateInspection({
    items: ITEMS, answers: allPass(), odometerText: '12,345', declaredUnsafe: false, notes: '',
    signedName: 'Jane Tech', hasSignature: true, ...over,
  });

describe('evaluateInspection', () => {
  it('is satisfactory when everything passes', () => {
    expect(evaluateInspection(ITEMS, allPass(), false)).toEqual({ status: 'satisfactory', defects: 0, blocking: 0 });
  });

  it('flags minor/major defects without blocking', () => {
    const a = allPass();
    a.horn = { result: 'defect', note: 'weak', photos: [] };
    expect(evaluateInspection(ITEMS, a, false)).toEqual({ status: 'defects_noted', defects: 1, blocking: 0 });
  });

  it('marks the vehicle unsafe when an out-of-service item fails', () => {
    const a = allPass();
    a.brakes = { result: 'defect', note: 'spongy', photos: [] };
    expect(evaluateInspection(ITEMS, a, false)).toEqual({ status: 'unsafe', defects: 1, blocking: 1 });
  });

  it('marks the vehicle unsafe when the driver declares it, even with no defects', () => {
    expect(evaluateInspection(ITEMS, allPass(), true).status).toBe('unsafe');
  });

  it('ignores N/A answers', () => {
    const a = allPass();
    a.brakes = { result: 'na', note: '', photos: [] };
    expect(evaluateInspection(ITEMS, a, false).status).toBe('satisfactory');
  });
});

describe('validateInspection', () => {
  it('accepts a complete, signed report', () => {
    expect(valid()).toEqual([]);
  });

  it('requires an odometer reading', () => {
    expect(valid({ odometerText: '' })).toContain('Enter the odometer reading');
    expect(valid({ odometerText: 'abc' })).toContain('Enter the odometer reading');
  });

  it('counts unanswered items', () => {
    expect(valid({ answers: emptyAnswers(ITEMS) })).toContain('3 checklist items not answered');
    const a = allPass();
    a.horn = { result: null, note: '', photos: [] };
    expect(valid({ answers: a })).toContain('1 checklist item not answered');
  });

  it('requires a description for every defect', () => {
    const a = allPass();
    a.horn = { result: 'defect', note: ' ', photos: [] };
    expect(valid({ answers: a })).toContain('Describe the defect: HORN');
  });

  it('requires a photo for out-of-service and photo-required items', () => {
    const a = allPass();
    a.brakes = { result: 'defect', note: 'spongy pedal', photos: [] };
    a.lights = { result: 'defect', note: 'left lamp out', photos: [] };
    const errs = valid({ answers: a });
    expect(errs).toContain('Add a photo: BRAKES');
    expect(errs).toContain('Add a photo: LIGHTS');
    a.brakes.photos = [new File(['x'], 'a.jpg')];
    a.lights.photos = [new File(['x'], 'b.jpg')];
    expect(valid({ answers: a })).toEqual([]);
  });

  it('requires an explanation when declaring unsafe', () => {
    expect(valid({ declaredUnsafe: true })).toContain('Explain why the vehicle is unsafe');
    expect(valid({ declaredUnsafe: true, notes: 'Smells of gas' })).toEqual([]);
  });

  it('requires a name and a signature', () => {
    expect(valid({ signedName: 'J' })).toContain('Type your full name');
    expect(valid({ hasSignature: false })).toContain('Sign the report');
  });
});

describe('helpers', () => {
  it('parses odometer text', () => {
    expect(parseOdometer('12,345.6')).toBe(12345.6);
    expect(parseOdometer(' 0 ')).toBe(0);
    expect(parseOdometer('-5')).toBeNull();
    expect(parseOdometer('5000000')).toBeNull();
    expect(parseOdometer('1e3')).toBeNull();
  });

  it('detects odometer rollback', () => {
    expect(isOdometerAnomaly(900, 1000)).toBe(true);
    expect(isOdometerAnomaly(1000, 1000)).toBe(false);
    expect(isOdometerAnomaly(10, null)).toBe(false);
  });

  it('knows when a photo is mandatory', () => {
    expect(photoRequired(ITEMS[0])).toBe(true);
    expect(photoRequired(ITEMS[1])).toBe(false);
    expect(photoRequired(ITEMS[2])).toBe(true);
  });

  it('groups by category in sort order', () => {
    const g = groupByCategory(ITEMS);
    expect(g.map((x) => x.category)).toEqual(['Safety', 'Visibility']);
    expect(g[1].items.map((i) => i.item_key)).toEqual(['horn', 'lights']);
  });

  it('slugifies checklist keys to the DB format', () => {
    expect(slugifyKey('  Fire Extinguisher (charged)! ')).toBe('fire_extinguisher_charged');
    expect(slugifyKey('A'.repeat(50))).toHaveLength(32);
    expect(slugifyKey('---')).toBe('');
  });

  it('titles faults from the description or the code', () => {
    expect(faultTitle({ code: 'DVIR:TIRES_WHEELS', description: 'Tires: bald' })).toBe('Tires: bald');
    expect(faultTitle({ code: 'DVIR:TIRES_WHEELS', description: null })).toBe('tires wheels');
  });

  it('detects blocked vehicles', () => {
    const faults = [{ vehicle_id: 'a', blocks_dispatch: false }, { vehicle_id: 'b', blocks_dispatch: true }];
    expect(vehicleBlocked(faults, 'a')).toBe(false);
    expect(vehicleBlocked(faults, 'b')).toBe(true);
  });

  it('extracts the dispatch-gate message from database errors', () => {
    expect(friendlyDispatchError('DVIR_BLOCKED: vehicle "Van 1" is out of service.')).toBe('vehicle "Van 1" is out of service.');
    expect(friendlyDispatchError('something else')).toBeNull();
    expect(friendlyDispatchError(undefined)).toBeNull();
  });
});
