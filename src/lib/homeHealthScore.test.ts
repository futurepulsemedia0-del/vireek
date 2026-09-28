import { describe, it, expect } from 'vitest';
import type { Equipment, EquipmentMaintenanceAlert, Job } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { classifyEquipment, computeHomeHealth, tierForScore } from './homeHealthScore';

const NOW = new Date('2026-06-01T00:00:00Z').getTime();

function yearsAgo(y: number): string {
  return new Date(NOW - y * 365.25 * 24 * 60 * 60 * 1000).toISOString();
}

function eq(over: Partial<Equipment> & { id: string; equipment_type: string }): Equipment {
  return {
    room_id: 'r1',
    user_id: 'u',
    customer_id: 'c',
    make: null,
    model: null,
    serial_number: null,
    install_date: yearsAgo(2),
    install_job_id: null,
    warranty_expires_at: null,
    warranty_notes: null,
    expected_lifespan_years: 15,
    service_interval_months: 12,
    last_service_date: yearsAgo(0.3),
    notes: null,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function twin(equipment: Equipment[], extra: Partial<PropertyTwin> = {}): PropertyTwin {
  return { site: null, equipment, jobs: [], jobEquipmentLinks: [], maintenanceAlerts: [], ...extra };
}

describe('classifyEquipment', () => {
  it('maps free-text types to categories', () => {
    expect(classifyEquipment({ equipment_type: 'Furnace', make: null, model: null })).toBe('hvac');
    expect(classifyEquipment({ equipment_type: 'Tankless Water Heater', make: null, model: null })).toBe('water_heater');
    expect(classifyEquipment({ equipment_type: 'Smoke detector', make: null, model: null })).toBe('safety');
    expect(classifyEquipment({ equipment_type: 'Main panel', make: 'Square D', model: null })).toBe('electrical');
    expect(classifyEquipment({ equipment_type: 'Sump pump', make: null, model: null })).toBe('plumbing');
    expect(classifyEquipment({ equipment_type: 'Asphalt shingle roof', make: null, model: null })).toBe('roof');
    expect(classifyEquipment({ equipment_type: 'Espresso machine', make: null, model: null })).toBeNull();
  });
});

describe('computeHomeHealth', () => {
  it('returns no score (not a fake number) when nothing is scorable', () => {
    const r = computeHomeHealth(twin([]), NOW);
    expect(r.score).toBeNull();
    expect(r.topRisks).toEqual([]);
    expect(r.confidence).toBe('low');
  });

  it('scores a young, serviced system highly', () => {
    const r = computeHomeHealth(twin([eq({ id: 'a', equipment_type: 'Furnace' })]), NOW);
    expect(r.score).toBeGreaterThanOrEqual(95);
    expect(tierForScore(r.score as number)).toBe('excellent');
  });

  it('penalises a unit far past its lifespan and ranks it as the top risk', () => {
    const old = eq({ id: 'old', equipment_type: 'Water Heater', install_date: yearsAgo(16), expected_lifespan_years: 10 });
    const fine = eq({ id: 'fine', equipment_type: 'Furnace' });
    const r = computeHomeHealth(twin([old, fine]), NOW);
    expect(r.categories.find((c) => c.key === 'water_heater')?.score).toBeLessThan(70);
    expect(r.topRisks[0]?.equipmentId).toBe('old');
    expect(r.topRisks[0]?.level).toBe('high');
    expect(r.topRisks[0]?.reason).toMatch(/past its expected 10-year lifespan/);
  });

  it('ignores replaced and removed equipment', () => {
    const r = computeHomeHealth(
      twin([eq({ id: 'x', equipment_type: 'Furnace', status: 'replaced', install_date: yearsAgo(40) })]),
      NOW,
    );
    expect(r.score).toBeNull();
  });

  it('does not treat routine maintenance visits as recurring failures', () => {
    const jobs = [1, 2, 3, 4].map((i) => ({ id: `j${i}`, job_status: 'completed', service_type: 'Annual tune-up', scheduled_datetime: yearsAgo(0.1 * i) })) as unknown as Job[];
    const links = jobs.map((j) => ({ job_id: j.id, equipment_id: 'a', service_type: null }));
    const r = computeHomeHealth(twin([eq({ id: 'a', equipment_type: 'Furnace' })], { jobs, jobEquipmentLinks: links }), NOW);
    expect(r.score).toBeGreaterThanOrEqual(95);
  });

  it('counts repeat repair visits and lowers the score', () => {
    const jobs = [1, 2, 3].map((i) => ({ id: `j${i}`, job_status: 'completed', service_type: 'Leak repair', scheduled_datetime: yearsAgo(0.2 * i) })) as unknown as Job[];
    const links = jobs.map((j) => ({ job_id: j.id, equipment_id: 'a', service_type: null }));
    const base = computeHomeHealth(twin([eq({ id: 'a', equipment_type: 'Furnace' })]), NOW).score as number;
    const r = computeHomeHealth(twin([eq({ id: 'a', equipment_type: 'Furnace' })], { jobs, jobEquipmentLinks: links }), NOW);
    expect(r.score as number).toBeLessThan(base - 10);
  });

  it('uses predictive alerts and projects a higher score once serviced', () => {
    const alert = { id: 'al', user_id: 'u', equipment_id: 'a', risk_level: 'high', predicted_issue: 'Compressor wear', recommended_action: 'Replace capacitor', predicted_service_due: null, is_dismissed: false, metric_snapshot: null, created_at: '' } as EquipmentMaintenanceAlert;
    const r = computeHomeHealth(twin([eq({ id: 'a', equipment_type: 'Furnace' })], { maintenanceAlerts: [alert] }), NOW);
    expect(r.topRisks[0]?.reason).toBe('Compressor wear');
    expect(r.topRisks[0]?.action).toBe('Replace capacitor');
    expect(r.projectedScore as number).toBeGreaterThan(r.score as number);
  });

  it('caps the headline score when a critical system exists', () => {
    const dead = eq({ id: 'd', equipment_type: 'Main panel', install_date: yearsAgo(60), expected_lifespan_years: 30, last_service_date: null, service_interval_months: 12 });
    const many = ['Furnace', 'Water Heater', 'Sump pump', 'Roof', 'Smoke detector'].map((t, i) => eq({ id: `ok${i}`, equipment_type: t }));
    const r = computeHomeHealth(twin([dead, ...many]), NOW);
    expect(r.categories.find((c) => c.key === 'electrical')?.score).toBeLessThan(40);
    expect(r.score as number).toBeLessThanOrEqual(69);
    expect(r.capped).toBe(true);
  });

  it('is deterministic', () => {
    const t = twin([eq({ id: 'a', equipment_type: 'Furnace', install_date: yearsAgo(11), expected_lifespan_years: 15 })]);
    expect(computeHomeHealth(t, NOW)).toEqual(computeHomeHealth(t, NOW));
  });
});
