import { describe, it, expect, vi } from 'vitest';
import type { Equipment, Job } from '@/lib/supabase';
import type { HomeLifetimeGraph } from '@/lib/homeLifetimeGraph';
import type { ChainReport } from '@/lib/jobEvidenceChain';
import {
  buildHomePassport, filterRecords, homeIdFromSiteId, toPassportExport,
  type EquipmentPassportLite, type PassportInputs,
} from './homePassport';

// homePassport reuses label maps from propertyIntelligence, which imports the Supabase client.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const NOW = new Date('2026-06-01T00:00:00Z').getTime();

const equipment = (over: Partial<Equipment> = {}): Equipment => ({
  id: 'e1', room_id: 'r1', equipment_type: 'furnace', make: 'Carrier', model: 'X1', serial_number: 'SN1',
  install_date: '2016-01-01', warranty_expires_at: null, expected_lifespan_years: 15, service_interval_months: 12,
  last_service_date: '2026-01-01', status: 'active', created_at: '2016-01-01T00:00:00Z', updated_at: '2016-01-01T00:00:00Z',
  ...over,
} as unknown as Equipment);

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', job_status: 'completed', service_type: 'Furnace repair', scheduled_datetime: '2025-05-01T10:00:00Z',
  invoice_amount: 400, tags: [], is_rework: false, assigned_technician_id: null, ...over,
} as unknown as Job);

const chain = (valid: boolean): ChainReport => ({
  job_id: 'j1', score: 92, level: 'strong', ready: true, stages: [], gaps: [], blocking_gaps: [],
  integrity: { valid, entries: 4, broken_seq: valid ? null : 2, reason: valid ? null : 'hash_mismatch', head_hash: 'abcdef1234567890' },
  stats: { system_verified: 3, human_recorded: 1, media_files: 2, before_after_measurement: true, before_after_media: true, chargeable: true, post_repair_test_passed: true },
  generated_at: '2025-05-02T00:00:00Z',
});

const ledger = (valid: boolean): EquipmentPassportLite => ({
  code: 'ABCDEFGHJKMN',
  integrity: { valid, checked: 1, head_hash: 'ffeeddccbbaa9988', ...(valid ? {} : { broken_at_seq: 1 }) },
  events: [{
    id: 'ev1', seq: 1, event_type: 'service_visit', title: 'Service visit', detail: null, occurred_at: '2025-05-01T10:00:00Z',
    recorded_at: '2025-05-01T12:00:00Z', contributor_name: 'Maria G.', is_mine: true, visibility: 'public', summary: {}, entry_hash: '0123456789abcdef',
  }],
});

function inputs(over: Partial<PassportInputs> = {}): PassportInputs {
  const graph: HomeLifetimeGraph = {
    twin: {
      site: { id: 's1', name: 'Maple House', address: '1 Maple St' } as never,
      equipment: [equipment()], jobs: [job()], jobEquipmentLinks: [{ job_id: 'j1', equipment_id: 'e1', service_type: 'repair' }],
      maintenanceAlerts: [],
    },
    siteId: '3f2a9c1e-77aa-4b1d-9c20-1234567890ab', currentCustomerId: 'c2', yearBuilt: 2010, schemaReady: true,
    ownership: [
      { id: 'o2', site_id: 's1', customer_id: 'c2', started_at: '2025-01-01', ended_at: null, transfer_reason: 'sale', notes: null, ownerName: 'New Owner' },
      { id: 'o1', site_id: 's1', customer_id: 'c1', started_at: '2016-01-01', ended_at: '2025-01-01', transfer_reason: null, notes: null, ownerName: 'Old Owner' },
    ],
    permits: [], contractors: [], interventions: [], warrantyClaims: [], technicianNames: {},
  };
  return { graph, intel: null, predictions: [], passports: {}, evidence: {}, outcomes: [], ...over };
}

describe('homeIdFromSiteId', () => {
  it('is deterministic, well-formed and differs per site', () => {
    const a = homeIdFromSiteId('3f2a9c1e-77aa-4b1d-9c20-1234567890ab');
    expect(a).toMatch(/^VHP-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(homeIdFromSiteId('3f2a9c1e-77aa-4b1d-9c20-1234567890ab')).toBe(a);
    expect(homeIdFromSiteId('aaaaaaaa-77aa-4b1d-9c20-1234567890ab')).not.toBe(a);
  });
});

describe('buildHomePassport', () => {
  it('stamps every record with source, confidence in [0,1] and a verification status', () => {
    const p = buildHomePassport(inputs(), NOW);
    expect(p.records.length).toBeGreaterThan(0);
    for (const r of p.records) {
      expect(r.source).toBeTruthy();
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(['verified', 'system', 'human', 'inferred', 'unverified']).toContain(r.verification);
    }
  });

  it('marks a valid hash chain as verified and a broken one as unverified', () => {
    const ok = buildHomePassport(inputs({ passports: { e1: ledger(true) }, evidence: { j1: chain(true) } }), NOW);
    expect(ok.records.find((r) => r.id === 'ledger-ABCDEFGHJKMN-1')?.verification).toBe('verified');
    expect(ok.records.find((r) => r.id === 'job-j1')?.verification).toBe('verified');
    expect(ok.trust.level).not.toBe('Thin');

    const bad = buildHomePassport(inputs({ passports: { e1: ledger(false) }, evidence: { j1: chain(false) } }), NOW);
    expect(bad.records.find((r) => r.id === 'ledger-ABCDEFGHJKMN-1')?.verification).toBe('unverified');
    expect(bad.records.find((r) => r.id === 'evidence-j1')?.confidence).toBeLessThanOrEqual(0.2);
    expect(bad.gaps.filter((g) => g.action === 'integrity').length).toBe(2);
    expect(bad.trust.level).toBe('Developing');
  });

  it('caps AI predictions as inferred and excludes them from the verified share', () => {
    const p = buildHomePassport(inputs({
      predictions: [{
        id: 'p1', customer_id: 'c2', equipment_id: 'e1', failure_mode: 'igniter', label: 'Igniter failure', probability: 0.8, confidence: 0.99,
        horizon_days_min: 10, horizon_days_max: 30, severity: 'high', probable_cause: 'Wear', evidence: [], status: 'active', updated_at: '2026-05-01T00:00:00Z',
        equipment: null, customer: null,
      }, {
        id: 'p2', customer_id: 'c2', equipment_id: 'OTHER-SITE', failure_mode: 'x', label: 'Elsewhere', probability: 0.5, confidence: 0.5,
        horizon_days_min: 1, horizon_days_max: 2, severity: 'watch', probable_cause: '', evidence: [], status: 'active', updated_at: '2026-05-01T00:00:00Z',
        equipment: null, customer: null,
      }],
    }), NOW);
    const ai = p.records.filter((r) => r.source === 'ai');
    expect(ai).toHaveLength(1);
    expect(ai[0].verification).toBe('inferred');
    expect(ai[0].confidence).toBeLessThanOrEqual(0.85);
  });

  it('keeps history across owners: records are attributed to the period they happened in', () => {
    const p = buildHomePassport(inputs(), NOW);
    expect(p.owners).toBe(2);
    const oldOwner = p.continuity.find((c) => c.id === 'o1');
    const newOwner = p.continuity.find((c) => c.id === 'o2');
    // The 2025-05-01 repair happened after the 2025-01-01 transfer; the 2016 install belongs to the first owner.
    expect(newOwner?.isCurrent).toBe(true);
    expect(newOwner?.repairs).toBe(1);
    expect(oldOwner?.repairs).toBe(0);
    expect(oldOwner?.records).toBeGreaterThan(0);
  });

  it('flags missing passports, evidence and identity as gaps, most severe first', () => {
    const p = buildHomePassport(inputs(), NOW);
    const actions = p.gaps.map((g) => g.action);
    expect(actions).toContain('passport');
    expect(actions).toContain('evidence');
    expect(actions).toContain('identity');
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < p.gaps.length; i += 1) expect(rank[p.gaps[i - 1].severity]).toBeLessThanOrEqual(rank[p.gaps[i].severity]);
  });

  it('handles an empty home without throwing', () => {
    const base = inputs();
    const p = buildHomePassport({
      ...base,
      graph: { ...base.graph, twin: { ...base.graph.twin, equipment: [], jobs: [], jobEquipmentLinks: [] }, ownership: [] },
    }, NOW);
    expect(p.owners).toBe(1);
    expect(p.trust.score).toBeGreaterThanOrEqual(0);
    expect(p.trust.score).toBeLessThanOrEqual(100);
    expect(p.trust.verifiedShare).toBe(0);
  });
});

describe('filterRecords / export', () => {
  it('filters by domain, verification and text', () => {
    const p = buildHomePassport(inputs({ passports: { e1: ledger(true) } }), NOW);
    expect(filterRecords(p.records, { domain: 'equipment', verification: 'all', query: '' }).every((r) => r.domain === 'equipment')).toBe(true);
    expect(filterRecords(p.records, { domain: 'all', verification: 'verified', query: '' }).every((r) => r.verification === 'verified')).toBe(true);
    expect(filterRecords(p.records, { domain: 'all', verification: 'all', query: 'zzzz-no-match' })).toHaveLength(0);
  });

  it('redacts owner names, ownership periods and predictions from the shareable export', () => {
    const p = buildHomePassport(inputs(), NOW);
    const json = JSON.stringify(toPassportExport(p));
    expect(json).not.toContain('Old Owner');
    expect(json).not.toContain('New Owner');
    expect(toPassportExport(p).records.some((r) => r.domain === 'ownership' || r.domain === 'risk')).toBe(false);
    expect(toPassportExport(p).schema).toBe('vireek.home-passport/1');
  });
});
