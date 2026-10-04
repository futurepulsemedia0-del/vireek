import { describe, it, expect } from 'vitest';
import type { Equipment } from '@/lib/supabase';
import {
  buildNodeTree,
  computeCoverage,
  deriveInsights,
  eligibleParents,
  parseFieldValues,
  CHARACTERISTIC_FIELDS,
  type IntelLayer,
  type IntelNode,
  type PropertyIntelligence,
} from '@/lib/propertyIntelligence';

const NOW = new Date('2026-10-01T00:00:00Z');

function layer(key: IntelLayer['layer'], data: Record<string, unknown>, status: IntelLayer['status'] = 'ok', confidence = 0.8): IntelLayer {
  return { id: key, layer: key, status, data, source: 'test', confidence, as_of: null, fetched_at: NOW.toISOString(), error: null };
}

function node(id: string, kind: IntelNode['kind'], parent: string | null = null, occurred_on: string | null = null): IntelNode {
  return { id, parent_id: parent, site_building_id: null, kind, name: id, occurred_on, attributes: {}, source: 'manual', verified: true, created_at: NOW.toISOString() };
}

function intel(partial: Partial<PropertyIntelligence> = {}): PropertyIntelligence {
  return {
    profile: {
      id: 'p',
      site_id: 's',
      normalized_address: null,
      latitude: 30,
      longitude: -97,
      geocode_confidence: 0.8,
      country_code: 'US',
      census_geoid: null,
      enrichment_status: 'complete',
      last_enriched_at: null,
    },
    layers: {},
    nodes: [],
    ...partial,
  };
}

function equip(over: Partial<Equipment>): Equipment {
  return {
    id: 'e1',
    room_id: null,
    user_id: 'u',
    customer_id: 'c',
    equipment_type: 'Furnace',
    make: 'Carrier',
    model: null,
    serial_number: null,
    install_date: '2008-01-01',
    install_job_id: null,
    warranty_expires_at: null,
    warranty_notes: null,
    expected_lifespan_years: 15,
    service_interval_months: 12,
    last_service_date: null,
    notes: null,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...over,
  };
}

describe('parseFieldValues', () => {
  it('omits empty values and validates ranges', () => {
    const { data, errors } = parseFieldValues(CHARACTERISTIC_FIELDS, { year_built: '1985', stories: '0', roof_type: 'metal', foundation_type: 'moon' });
    expect(data).toEqual({ year_built: 1985, roof_type: 'metal' });
    expect(errors.stories).toBeDefined();
    expect(errors.foundation_type).toBeDefined();
  });

  it('rejects non-numeric numbers', () => {
    expect(parseFieldValues(CHARACTERISTIC_FIELDS, { year_built: 'abc' }).errors.year_built).toBe('Enter a number');
  });
});

describe('buildNodeTree', () => {
  it('nests children, sorts history by date and keeps orphans as roots', () => {
    const tree = buildNodeTree([
      node('b', 'building', 'pc'),
      node('pc', 'parcel'),
      node('p2', 'permit', 'b', '2020-01-01'),
      node('p1', 'permit', 'b', '2010-01-01'),
      node('orphan', 'unit', 'missing'),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['pc', 'orphan']);
    expect(tree[0].children[0].children.map((n) => n.id)).toEqual(['p1', 'p2']);
  });
});

describe('eligibleParents', () => {
  it('mirrors the hierarchy rules', () => {
    const nodes = [node('pc', 'parcel'), node('b', 'building'), node('s', 'structure'), node('u', 'unit')];
    expect(eligibleParents('parcel', nodes)).toEqual([]);
    expect(eligibleParents('structure', nodes).map((n) => n.id)).toEqual(['b']);
    expect(eligibleParents('construction_event', nodes)).toHaveLength(4);
  });
});

describe('computeCoverage', () => {
  it('is zero-ish for an empty profile and rises with verified data', () => {
    const empty = computeCoverage(intel({ profile: { ...intel().profile, latitude: null, longitude: null } }), 0);
    expect(empty.score).toBe(0);
    const rich = computeCoverage(
      intel({
        layers: { climate: layer('climate', {}), hazards: layer('hazards', {}), characteristics: layer('characteristics', { year_built: 1990 }, 'manual') },
        nodes: [node('pc', 'parcel'), node('b', 'building', 'pc'), node('s', 'structure', 'b')],
      }),
      3,
    );
    expect(rich.score).toBeGreaterThan(40);
    expect(rich.score).toBeLessThanOrEqual(100);
    expect(rich.gaps.some((g) => g.key === 'energy')).toBe(true);
  });

  it('weights partial layers at half confidence', () => {
    const full = computeCoverage(intel({ layers: { hazards: layer('hazards', {}, 'ok', 0.8) } }), 0);
    const part = computeCoverage(intel({ layers: { hazards: layer('hazards', {}, 'partial', 0.8) } }), 0);
    expect(full.score).toBeGreaterThan(part.score);
  });
});

describe('deriveInsights', () => {
  it('flags aging heating equipment only in a heating-dominated climate', () => {
    const cold = intel({ layers: { climate: layer('climate', { climate_profile: 'heating_dominated', hdd65_f: 6000 }) } });
    const warm = intel({ layers: { climate: layer('climate', { climate_profile: 'cooling_dominated', cdd65_f: 3000, hdd65_f: 1000 }) } });
    const f = equip({ install_date: '2006-01-01' });
    expect(deriveInsights(cold, [f], NOW).find((i) => i.id === 'aging-heating-cold-climate')?.severity).toBe('high');
    expect(deriveInsights(warm, [f], NOW).find((i) => i.id === 'aging-heating-cold-climate')).toBeUndefined();
  });

  it('flags era-based compliance and impossible install dates', () => {
    const i = intel({ layers: { characteristics: layer('characteristics', { year_built: 1970 }, 'manual') } });
    const ids = deriveInsights(i, [equip({ install_date: '1960-05-01' })], NOW).map((x) => x.id);
    expect(ids).toContain('pre-1978');
    expect(ids).toContain('aluminum-wiring-era');
    expect(ids).toContain('equipment-predates-building');
  });

  it('does not report permit gaps when no permits are recorded', () => {
    const none = deriveInsights(intel(), [equip({})], NOW);
    expect(none.find((x) => x.id === 'permit-gap')).toBeUndefined();
    const withPermit = deriveInsights(intel({ nodes: [node('pm', 'permit', null, '1999-01-01')] }), [equip({})], NOW);
    expect(withPermit.find((x) => x.id === 'permit-gap')).toBeDefined();
  });

  it('flags FEMA special flood hazard areas and sorts by severity', () => {
    const i = intel({ layers: { hazards: layer('hazards', { flood: { sfha: true, zone: 'AE' } }) } });
    const result = deriveInsights(i, [], NOW);
    expect(result[0].id).toBe('flood-sfha');
    expect(result[0].evidence[0]).toContain('AE');
  });
});
