import { describe, expect, it, vi } from 'vitest';
import {
  assessJobUnknowns,
  type RawDiagnosisSession,
  type RawEquipment,
  type RawNetworkEvidence,
  type UnknownsInput,
} from '@/lib/unknownsEngine';
import { buildNetworkEvidence, normalizePartNumber } from '@/lib/unknownsNetworkApi';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const unit: RawEquipment = { id: 'eq1', equipment_type: 'furnace', make: 'Carrier', model: '59TP6', serial_number: 'SN1', install_date: '2020-01-01', status: 'active' };
const session: RawDiagnosisSession = {
  id: 's', equipment_id: 'eq1', confidence: 0.8, severity: 'medium', top_cause: 'Dirty flame sensor',
  top_likelihood: 0.8, missing_info: [], parts: [{ name: 'Flame sensor', necessity: 'likely' }], created_at: '2026-10-01T10:00:00Z',
};
const net = (over: Partial<RawNetworkEvidence> = {}): RawNetworkEvidence => ({
  model_label: '59TP6', model_source: 'oem_api', match_confidence: 0.95, parts_total: 1, parts_catalog_matched: 1, failure_patterns: [], ...over,
});
const base = (network: RawNetworkEvidence | null): UnknownsInput => ({
  job: { id: 'j', job_status: 'scheduled', service_type: 'Repair', dispatch_note: 'Gate code 1234 dog', address: '1 Main', latitude: 1, longitude: 2, site_id: null, customer_phone: '5', quote_id: null, invoice_amount: null, technician_diagnosis: null, diagnosis_notes: null, before_photo_count: 0 },
  diagnosis: { ok: true, data: [session] },
  equipment: { ok: true, data: [unit] },
  parts: { ok: true, data: [{ status: 'allocated' }] },
  site: { ok: true, data: null },
  compliance: { ok: true, data: null },
  noSurprise: null,
  network,
  resolutions: [],
});
const dim = (i: UnknownsInput, k: string) => assessJobUnknowns(i).dimensions.find((d) => d.key === k)!;

describe('part compatibility with catalog evidence', () => {
  it('without network evidence it stays capped and unverified', () => {
    const d = dim(base(null), 'part_compatibility');
    expect(d.status).toBe('unverified');
    expect(d.confidencePct).toBeLessThanOrEqual(85);
  });
  it('all parts in a real manufacturer catalog lifts it to likely, never known', () => {
    const d = dim(base(net()), 'part_compatibility');
    expect(d.status).toBe('likely');
    expect(d.confidencePct).toBeGreaterThan(85);
    expect(d.confidencePct).toBeLessThan(90);
  });
  it('an internally seeded catalog does not lift the cap', () => {
    const d = dim(base(net({ model_source: 'internal' })), 'part_compatibility');
    expect(d.status).toBe('unverified');
    expect(d.confidencePct).toBeLessThanOrEqual(85);
  });
  it('an unmatched part is flagged and lowers confidence', () => {
    const d = dim(base(net({ parts_total: 2, parts_catalog_matched: 1 })), 'part_compatibility');
    expect(d.status).toBe('unverified');
    expect(d.gaps.join(' ')).toMatch(/not in the catalog/);
  });
  it('a weak OEM match is ignored', () => {
    expect(dim(base(net({ match_confidence: 0.5 })), 'part_compatibility').status).toBe('unverified');
  });
});

describe('diagnosis corroboration', () => {
  it('a well-sampled matching failure pattern adds evidence and a small bonus', () => {
    const without = dim(base(null), 'diagnosis').confidencePct;
    const d = dim(base(net({ failure_patterns: [{ failure_mode: 'Flame sensor fouling', sample_size: 40 }] })), 'diagnosis');
    expect(d.confidencePct).toBe(without + 5);
    expect(d.evidence.join(' ')).toMatch(/Network history/);
    expect(d.status).toBe('unverified');
  });
  it('thin samples and unrelated patterns do nothing, and never create a contradiction', () => {
    const without = dim(base(null), 'diagnosis').confidencePct;
    for (const p of [{ failure_mode: 'Flame sensor fouling', sample_size: 3 }, { failure_mode: 'Cracked heat exchanger', sample_size: 90 }]) {
      const d = dim(base(net({ failure_patterns: [p] })), 'diagnosis');
      expect(d.confidencePct).toBe(without);
      expect(d.status).not.toBe('contradictory');
    }
  });
});

describe('buildNetworkEvidence', () => {
  it('normalizes part numbers and matches job parts to the best-linked model catalog', () => {
    expect(normalizePartNumber('ab-123 / x')).toBe('AB123X');
    expect(normalizePartNumber('1')).toBeNull();
    const m = buildNetworkEvidence(
      {
        jobEquipment: [{ job_id: 'j', equipment_id: 'e1' }, { job_id: 'j', equipment_id: 'e2' }],
        links: [
          { equipment_id: 'e1', model_id: 'm1', match_confidence: 0.6 },
          { equipment_id: 'e2', model_id: 'm2', match_confidence: 0.9 },
        ],
        models: [{ id: 'm1', model_number: 'A', source: 'internal' }, { id: 'm2', model_number: 'B', source: 'oem_api' }],
        patterns: [{ model_id: 'm2', failure_mode: 'x', sample_size: 30 }],
        catalogParts: [{ model_id: 'm2', part_number: 'AB-123' }],
        jobParts: [{ job_id: 'j', part_number: 'ab 123' }, { job_id: 'j', part_number: null }],
      },
      ['j', 'other'],
    );
    expect(m.get('other')).toBeUndefined();
    const e = m.get('j')!;
    expect(e.model_label).toBe('B');
    expect(e.parts_total).toBe(2);
    expect(e.parts_catalog_matched).toBe(1);
    expect(e.failure_patterns).toHaveLength(1);
  });
});
