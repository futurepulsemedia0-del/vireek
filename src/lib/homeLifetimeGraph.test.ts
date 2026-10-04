import { describe, it, expect } from 'vitest';
import type { Equipment, Job } from '@/lib/supabase';
import {
  buildCosts, buildIntelligence, classifyJob, completedHistory, deriveHomeView, warrantyState,
  type HomeLifetimeGraph,
} from './homeLifetimeGraph';

const NOW = new Date('2026-06-01T00:00:00Z').getTime();

function graph(over: Partial<HomeLifetimeGraph> = {}): HomeLifetimeGraph {
  return {
    twin: { site: null, equipment: [], jobs: [], jobEquipmentLinks: [], maintenanceAlerts: [] },
    siteId: 's1', currentCustomerId: 'c1', yearBuilt: null, schemaReady: true,
    ownership: [], permits: [], contractors: [], interventions: [], warrantyClaims: [], technicianNames: {},
    ...over,
  };
}

const job = (over: Partial<Job>): Job => ({
  id: 'j1', job_status: 'completed', service_type: 'AC repair', scheduled_datetime: '2025-05-01T10:00:00Z',
  invoice_amount: 250, tags: [], is_rework: false, assigned_technician_id: null, ...over,
} as unknown as Job);

describe('classifyJob', () => {
  it('separates repair, replacement, maintenance', () => {
    expect(classifyJob({ service_type: 'Furnace repair' })).toBe('repair');
    expect(classifyJob({ service_type: 'Water heater replacement' })).toBe('replacement');
    expect(classifyJob({ service_type: 'Replace air filter' })).toBe('maintenance');
    expect(classifyJob({ service_type: 'Annual tune-up' })).toBe('maintenance');
    expect(classifyJob({ service_type: 'Anything', is_rework: true })).toBe('repair');
    expect(classifyJob({ service_type: null })).toBe('other');
  });
});

describe('warrantyState', () => {
  it('classifies relative to now', () => {
    expect(warrantyState(null, NOW)).toBe('none');
    expect(warrantyState('2026-01-01', NOW)).toBe('expired');
    expect(warrantyState('2026-07-01', NOW)).toBe('expiring');
    expect(warrantyState('2028-01-01', NOW)).toBe('active');
  });
});

describe('home graph derivations', () => {
  it('keeps cost and history independent of ownership', () => {
    const twin = { site: null, equipment: [] as Equipment[], jobs: [job({}), job({ id: 'j2', invoice_amount: 100, service_type: 'Tune-up' })], jobEquipmentLinks: [], maintenanceAlerts: [] };
    const owners = [
      { id: 'p2', site_id: 's1', customer_id: 'c2', started_at: '2026-01-01', ended_at: null, transfer_reason: null, notes: null, ownerName: 'New' },
      { id: 'p1', site_id: 's1', customer_id: 'c1', started_at: '2020-01-01', ended_at: '2026-01-01', transfer_reason: 'sale' as const, notes: null, ownerName: 'Old' },
    ];
    const one = graph({ twin });
    const two = graph({ twin, ownership: owners });
    expect(buildCosts(two, completedHistory(two), NOW).serviceCents).toBe(35000);
    expect(buildCosts(two, completedHistory(two), NOW).serviceCents).toBe(buildCosts(one, completedHistory(one), NOW).serviceCents);
    const view = deriveHomeView(two, NOW);
    expect(view.intelligence.previousOwners).toBe(1);
    expect(view.timeline.some((e) => e.kind === 'ownership')).toBe(true);
  });

  it('scores 0 intelligence for an empty home', () => {
    const g = graph();
    const v = deriveHomeView(g, NOW);
    expect(buildIntelligence(g, v.history, v.systems, v.costs, 0).score).toBe(0);
  });
});
