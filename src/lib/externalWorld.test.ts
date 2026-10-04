import { describe, it, expect } from 'vitest';
import {
  classifyEquipment,
  generateInsights,
  type AssetInPlace,
  type PropertyContext,
} from './externalWorld';

const baseCtx = (over: Partial<PropertyContext> = {}): PropertyContext => ({
  propertyKey: 'property:1 main st',
  label: '1 Main St',
  location: null,
  alerts: [],
  forecast: null,
  climate: null,
  hazards: null,
  energy: null,
  facts: [],
  lastFetchedAt: null,
  ...over,
});

const ac = (over: Partial<AssetInPlace> = {}): AssetInPlace => ({
  assetKey: 'asset:1',
  propertyKey: 'property:1 main st',
  label: 'Carrier 24ACC',
  equipmentType: 'Air Conditioner',
  ageYears: 13,
  overdueMaintenance: false,
  ...over,
});

describe('classifyEquipment', () => {
  it('classifies common trade equipment', () => {
    expect(classifyEquipment('Tankless Water Heater')).toBe('water_heater');
    expect(classifyEquipment('Heat Pump')).toBe('heat_pump');
    expect(classifyEquipment('Gas Furnace')).toBe('heating');
    expect(classifyEquipment('Central AC')).toBe('cooling');
    expect(classifyEquipment('Roof')).toBe('roof');
    expect(classifyEquipment('Widget')).toBe('other');
  });
});

describe('generateInsights', () => {
  const hot = { mean_c: 22, max_c: 30, min_c: 12, hdd_c: 400, cdd_c: 1500, estimated: false };

  it('flags an old AC under heavy cooling load as act', () => {
    const out = generateInsights([baseCtx({ climate: hot })], [ac()]);
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('climate_age');
    expect(out[0].severity).toBe('act');
  });

  it('stays silent without external data', () => {
    expect(generateInsights([baseCtx()], [ac()])).toHaveLength(0);
  });

  it('bumps severity when maintenance is overdue', () => {
    const forecastOnly = baseCtx({ forecast: { max_f: 100, min_f: 70 } });
    const plain = generateInsights([forecastOnly], [ac({ ageYears: 9 })]);
    const overdue = generateInsights([forecastOnly], [ac({ ageYears: 9, overdueMaintenance: true })]);
    expect(plain[0].severity).toBe('watch');
    expect(overdue[0].severity).toBe('act');
  });

  it('uses very-high hazard ratings as act', () => {
    const ctx = baseCtx({
      hazards: { risk_rating: 'High', risk_score: 90, eal_total: 1, county_name: 'X', hazards: { HAIL: 'Very High' } },
    });
    const out = generateInsights([ctx], [ac()]);
    expect(out.find((i) => i.rule === 'hazard')?.severity).toBe('act');
  });
});
