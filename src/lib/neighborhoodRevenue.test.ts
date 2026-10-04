import { describe, it, expect } from 'vitest';
import {
  serviceCategory, evaluateNeed, channelEligibility, assessProperties, buildNeighborhoodPlan,
  opportunityScore, canTransition, requiresAck, isStaleOpportunity,
  type NearbyProperty,
} from './neighborhoodRevenue';

const NOW = new Date('2026-10-01T00:00:00Z').getTime();
const yearsAgo = (y: number) => new Date(NOW - y * 365.25 * 86_400_000).toISOString().slice(0, 10);

function prop(over: Partial<NearbyProperty> = {}): NearbyProperty {
  return {
    customer_id: 'c1', customer_name: 'A', address: '1 Main', distance_m: 300,
    last_job_at: null, last_service_type: null, jobs_count: 1, equipment: [],
    marketing_opt_in: false, has_phone: true, has_email: true, on_dnc: false, ...over,
  };
}
const furnace = (install: string, last: string | null = null) => ({
  equipment_type: 'Furnace', install_date: install, expected_lifespan_years: 15,
  service_interval_months: 12, last_service_date: last,
});

describe('serviceCategory', () => {
  it('classifies common trades', () => {
    expect(serviceCategory('HVAC replacement')).toBe('hvac');
    expect(serviceCategory('Water heater install')).toBe('plumbing');
    expect(serviceCategory('Panel upgrade')).toBe('electrical');
    expect(serviceCategory('Roof repair')).toBe('roofing');
    expect(serviceCategory('Window cleaning')).toBe('general');
    expect(serviceCategory(null)).toBe('general');
  });
});

describe('evaluateNeed', () => {
  it('flags replacement window at >= 80% of lifespan', () => {
    const n = evaluateNeed(prop({ equipment: [furnace(yearsAgo(13))] }), 'hvac', NOW);
    expect(n.signal).toBe('replacement_window');
  });
  it('flags maintenance when service interval is exceeded', () => {
    const n = evaluateNeed(prop({ equipment: [furnace(yearsAgo(3), yearsAgo(2))] }), 'hvac', NOW);
    expect(n.signal).toBe('maintenance_due');
  });
  it('returns none for new, recently serviced equipment', () => {
    const n = evaluateNeed(prop({ equipment: [furnace(yearsAgo(2), yearsAgo(0.2))] }), 'hvac', NOW);
    expect(n.signal).toBe('none');
  });
  it('ignores equipment of a different category', () => {
    const n = evaluateNeed(prop({ equipment: [{ ...furnace(yearsAgo(14)), equipment_type: 'Water Heater' }] }), 'hvac', NOW);
    expect(n.signal).toBe('none');
  });
  it('cold start falls back to service recency', () => {
    const stale = prop({ last_service_type: 'HVAC tune-up', last_job_at: new Date(NOW - 20 * 30.4 * 86_400_000).toISOString() });
    expect(evaluateNeed(stale, 'hvac', NOW).signal).toBe('maintenance_due');
    const fresh = prop({ last_service_type: 'HVAC tune-up', last_job_at: new Date(NOW - 30 * 86_400_000).toISOString() });
    expect(evaluateNeed(fresh, 'hvac', NOW).signal).toBe('none');
  });
});

describe('channelEligibility', () => {
  it('always allows non-personal channels', () => {
    expect(channelEligibility(prop(), 'door_hanger').eligible).toBe(true);
  });
  it('blocks personal channels without opt-in', () => {
    expect(channelEligibility(prop(), 'sms_opt_in').eligible).toBe(false);
  });
  it('blocks SMS for do-not-contact numbers even with opt-in', () => {
    const r = channelEligibility(prop({ marketing_opt_in: true, on_dnc: true }), 'sms_opt_in');
    expect(r.eligible).toBe(false);
  });
  it('allows opted-in email', () => {
    expect(channelEligibility(prop({ marketing_opt_in: true }), 'email_opt_in').eligible).toBe(true);
  });
});

describe('buildNeighborhoodPlan', () => {
  it('projects bookings and route density', () => {
    const props = [
      prop({ customer_id: 'a', marketing_opt_in: true, equipment: [furnace(yearsAgo(14))] }),
      prop({ customer_id: 'b', equipment: [furnace(yearsAgo(14))] }),
      prop({ customer_id: 'c', on_dnc: true }),
    ];
    const plan = buildNeighborhoodPlan(assessProperties(props, 'hvac', NOW), 3, 1500);
    expect(plan.totalNearby).toBe(3);
    expect(plan.withSignal).toBe(2);
    expect(plan.reachable.sms_opt_in).toBe(1);
    expect(plan.suppressedByDnc).toBe(1);
    expect(plan.stopsInZone.existing).toBe(3);
    expect(plan.densityGrade).toBe('building');
    expect(plan.projectedBookings.low).toBeLessThanOrEqual(plan.projectedBookings.expected);
    expect(plan.projectedBookings.expected).toBeLessThanOrEqual(plan.projectedBookings.high);
  });
  it('handles an empty neighborhood', () => {
    const plan = buildNeighborhoodPlan([], 0, 1500);
    expect(plan.withSignal).toBe(0);
    expect(plan.densityGrade).toBe('sparse');
    expect(plan.estimatedDriveMinutesSaved).toBe(0);
  });
});

describe('opportunityScore / lifecycle', () => {
  it('stays within 0..100 and rewards signal + density', () => {
    const low = opportunityScore({ withSignal: 0, totalNearby: 0, scheduledNearby: 0, completedAt: yearsAgo(1) }, NOW);
    const high = opportunityScore({ withSignal: 10, totalNearby: 20, scheduledNearby: 5, completedAt: new Date(NOW).toISOString() }, NOW);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(100);
    expect(high).toBeGreaterThan(low);
  });
  it('enforces the campaign state machine', () => {
    expect(canTransition('draft', 'approved')).toBe(true);
    expect(canTransition('draft', 'active')).toBe(false);
    expect(canTransition('completed', 'draft')).toBe(false);
    expect(requiresAck('active')).toBe(true);
    expect(requiresAck('cancelled')).toBe(false);
  });
  it('detects stale opportunities', () => {
    expect(isStaleOpportunity(new Date(NOW - 90 * 86_400_000).toISOString(), NOW)).toBe(true);
    expect(isStaleOpportunity(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe(false);
  });
});
