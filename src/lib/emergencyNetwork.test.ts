import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  PIPELINE,
  computeStats,
  formatEtaMinutes,
  formatSla,
  isActive,
  needsAttention,
  pipelineProgress,
  slaView,
  validateSettings,
  type EmergencyIncident,
  type SettingsInput,
} from './emergencyNetwork';

const NOW = new Date('2026-09-01T02:13:00Z');

function incident(over: Partial<EmergencyIncident> = {}): EmergencyIncident {
  return {
    id: 'i1',
    source: 'call',
    job_id: null,
    customer_name: 'Jane',
    customer_phone: null,
    address: null,
    description: 'Pipe burst',
    hazards: [],
    required_trade: 'plumbing',
    severity_tier: 'critical',
    severity_score: 100,
    severity_reason: null,
    insurance_involved: false,
    sla_minutes: 60,
    sla_due_at: new Date(NOW.getTime() + 50 * 60000).toISOString(),
    status: 'dispatching',
    stage: 'dispatch',
    assigned_technician_name: null,
    eta_minutes_est: null,
    decision: {},
    handoff_id: null,
    partner_name: null,
    partner_phone: null,
    last_error: null,
    first_response_at: null,
    resolved_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

function settings(over: Partial<SettingsInput> = {}): SettingsInput {
  return {
    enabled: true,
    auto_dispatch: true,
    auto_network_handoff: false,
    max_internal_eta_minutes: 45,
    network_wait_minutes: 12,
    sla_critical_minutes: 60,
    sla_high_minutes: 120,
    sla_standard_minutes: 240,
    customer_updates: true,
    publish_estimated_eta: true,
    notify_phone: null,
    referral_fee_pct: 10,
    ...over,
  };
}

describe('slaView', () => {
  it('is ok with plenty of time, at_risk near the end and breached after it', () => {
    expect(slaView(incident(), NOW).state).toBe('ok');
    expect(slaView(incident({ sla_due_at: new Date(NOW.getTime() + 10 * 60000).toISOString() }), NOW).state).toBe('at_risk');
    expect(slaView(incident({ sla_due_at: new Date(NOW.getTime() - 5 * 60000).toISOString() }), NOW).state).toBe('breached');
  });
  it('is met or missed once someone has been committed', () => {
    const due = new Date(NOW.getTime() + 10 * 60000).toISOString();
    expect(slaView(incident({ sla_due_at: due, first_response_at: NOW.toISOString() }), NOW).state).toBe('met');
    const late = new Date(NOW.getTime() + 20 * 60000).toISOString();
    expect(slaView(incident({ sla_due_at: due, first_response_at: late }), NOW).state).toBe('missed');
  });
});

describe('formatSla', () => {
  it('describes each state', () => {
    expect(formatSla({ state: 'ok', minutesLeft: 45 })).toBe('45m to response target');
    expect(formatSla({ state: 'ok', minutesLeft: 90 })).toBe('1h 30m to response target');
    expect(formatSla({ state: 'breached', minutesLeft: -7 })).toBe('Target passed 7m ago');
    expect(formatSla({ state: 'met', minutesLeft: 5 })).toBe('Response target met');
  });
});

describe('pipelineProgress', () => {
  it('marks earlier steps done, the stage current and later steps pending', () => {
    const steps = pipelineProgress(incident({ stage: 'tech_prep', status: 'assigned' }));
    expect(steps).toHaveLength(PIPELINE.length);
    expect(steps.find((s) => s.key === 'dispatch')?.state).toBe('done');
    expect(steps.find((s) => s.key === 'tech_prep')?.state).toBe('current');
    expect(steps.find((s) => s.key === 'payment')?.state).toBe('pending');
  });
  it('shows the stuck step as failed when a person is needed', () => {
    const steps = pipelineProgress(incident({ stage: 'dispatch', status: 'needs_human' }));
    expect(steps.find((s) => s.key === 'dispatch')?.state).toBe('failed');
  });
  it('marks everything done at the end', () => {
    expect(pipelineProgress(incident({ stage: 'done', status: 'closed' })).every((s) => s.state === 'done')).toBe(true);
  });
});

describe('status helpers', () => {
  it('knows active and attention states', () => {
    expect(isActive('en_route')).toBe(true);
    expect(isActive('closed')).toBe(false);
    expect(isActive('cancelled')).toBe(false);
    expect(needsAttention({ status: 'needs_human' })).toBe(true);
    expect(needsAttention({ status: 'network_pending_approval' })).toBe(true);
    expect(needsAttention({ status: 'assigned' })).toBe(false);
  });
});

describe('computeStats', () => {
  it('counts only open incidents', () => {
    const stats = computeStats(
      [
        incident({ id: 'a', status: 'assigned' }),
        incident({ id: 'b', status: 'needs_human' }),
        incident({ id: 'c', status: 'handed_off' }),
        incident({ id: 'd', status: 'network_search' }),
        incident({ id: 'e', status: 'closed' }),
        incident({ id: 'f', status: 'assigned', sla_due_at: new Date(NOW.getTime() - 60000).toISOString() }),
      ],
      NOW,
    );
    expect(stats).toEqual({ active: 5, needsAttention: 1, withPartner: 2, slaBreached: 1 });
  });
});

describe('formatEtaMinutes', () => {
  it('formats minutes, hours and missing values', () => {
    expect(formatEtaMinutes(25)).toBe('25 min');
    expect(formatEtaMinutes(60)).toBe('1 h');
    expect(formatEtaMinutes(95)).toBe('1 h 35 min');
    expect(formatEtaMinutes(null)).toBe('—');
  });
});

describe('validateSettings', () => {
  it('accepts sane defaults', () => {
    expect(validateSettings(settings())).toBeNull();
  });
  it('rejects out-of-range values', () => {
    expect(validateSettings(settings({ max_internal_eta_minutes: 2 }))).toMatch(/ETA/);
    expect(validateSettings(settings({ network_wait_minutes: 90 }))).toMatch(/wait/);
    expect(validateSettings(settings({ sla_high_minutes: 5 }))).toMatch(/targets/);
    expect(validateSettings(settings({ referral_fee_pct: 80 }))).toMatch(/fee/);
    expect(validateSettings(settings({ notify_phone: 'abc' }))).toMatch(/phone/);
  });
  it('accepts a valid alert phone number', () => {
    expect(validateSettings(settings({ notify_phone: '+1 (555) 123-4567' }))).toBeNull();
  });
});
