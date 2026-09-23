import { describe, it, expect } from 'vitest';
import { suggestTechnicians } from './dispatch';
import type { Job, TeamMember } from '@/lib/supabase';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    site_id: null,
    id: 'job-1',
    user_id: 'user-1',
    lead_id: null,
    call_id: null,
    customer_id: null,
    customer_name: 'Jane Doe',
    customer_phone: null,
    service_type: 'plumbing',
    address: '123 Main St, Austin',
    scheduled_datetime: '2026-09-24T14:00:00.000Z',
    duration_minutes: 60,
    assigned_technician_id: null,
    job_status: 'scheduled',
    tags: [],
    invoice_amount: null,
    invoice_status: 'not_sent',
    customer_country: null,
    customer_vat_number: null,
    invoice_currency: null,
    invoice_vat_rate: null,
    invoice_vat_amount: null,
    invoice_reverse_charge: false,
    dispatch_note: null,
    reschedule_token: 'tok',
    rescheduled_by_customer_at: null,
    eta_minutes: null,
    eta_set_at: null,
    technician_lat: null,
    technician_lng: null,
    location_updated_at: null,
    customer_type: 'residential',
    sla_response_hours: null,
    contract_reference: null,
    is_rework: false,
    rework_of_job_id: null,
    completed_at: null,
    latitude: null,
    longitude: null,
    geocoded_at: null,
    created_at: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function makeTechnician(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'tech-1',
    account_owner_id: 'user-1',
    member_email: 'tech@example.com',
    member_name: 'Tech One',
    role: 'technician',
    permissions: {
      can_view_billing: false,
      can_manage_team: false,
      can_edit_business_profile: false,
      can_view_all_jobs: false,
    },
    invite_status: 'active',
    last_invited_at: null,
    skills: [],
    languages: [],
    service_area: null,
    max_jobs_per_day: 6,
    dispatch_enabled: true,
    member_phone: null,
    hourly_cost_rate_cents: null,
    home_address: null,
    home_latitude: null,
    home_longitude: null,
    home_geocoded_at: null,
    current_latitude: null,
    current_longitude: null,
    location_updated_at: null,
    territory_id: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('suggestTechnicians', () => {
  it('excludes non-technician roles and technicians with dispatch disabled', () => {
    const job = makeJob();
    const techs = [
      makeTechnician({ id: 'admin-1', role: 'admin' }),
      makeTechnician({ id: 'tech-off', dispatch_enabled: false }),
      makeTechnician({ id: 'tech-on' }),
    ];
    const result = suggestTechnicians(job, techs, {});
    expect(result.map((r) => r.technician.id)).toEqual(['tech-on']);
  });

  it('excludes a technician who is already at full capacity for that day', () => {
    const job = makeJob({ scheduled_datetime: '2026-09-24T14:00:00.000Z' });
    const tech = makeTechnician({ id: 'tech-1', max_jobs_per_day: 2 });
    const jobsByTechnician = {
      'tech-1': [
        makeJob({ id: 'j1', scheduled_datetime: '2026-09-24T09:00:00.000Z' }),
        makeJob({ id: 'j2', scheduled_datetime: '2026-09-24T11:00:00.000Z' }),
      ],
    };
    const result = suggestTechnicians(job, [tech], jobsByTechnician);
    expect(result).toHaveLength(0);
  });

  it('does not count jobs scheduled on a different day toward capacity', () => {
    const job = makeJob({ scheduled_datetime: '2026-09-24T14:00:00.000Z' });
    const tech = makeTechnician({ id: 'tech-1', max_jobs_per_day: 1 });
    const jobsByTechnician = {
      'tech-1': [makeJob({ id: 'j1', scheduled_datetime: '2026-09-20T09:00:00.000Z' })],
    };
    const result = suggestTechnicians(job, [tech], jobsByTechnician);
    expect(result).toHaveLength(1);
  });

  it('scores a skill match higher than an equally-loaded technician without one', () => {
    const job = makeJob({ service_type: 'hvac' });
    const skilled = makeTechnician({ id: 'skilled', skills: ['hvac'] });
    const unskilled = makeTechnician({ id: 'unskilled', skills: ['plumbing'] });
    const result = suggestTechnicians(job, [skilled, unskilled], {});
    expect(result[0].technician.id).toBe('skilled');
    expect(result[0].reasons).toContain('Skilled in hvac');
  });

  it('adds a service-area bonus only when the job address contains the technician area', () => {
    const job = makeJob({ address: '500 Congress Ave, Austin, TX' });
    const covers = makeTechnician({ id: 'covers', service_area: 'Austin' });
    const doesNotCover = makeTechnician({ id: 'elsewhere', service_area: 'Dallas' });
    const result = suggestTechnicians(job, [covers, doesNotCover], {});
    const coversResult = result.find((r) => r.technician.id === 'covers')!;
    const elsewhereResult = result.find((r) => r.technician.id === 'elsewhere')!;
    expect(coversResult.score).toBeGreaterThan(elsewhereResult.score);
  });

  it('sorts by score descending, best match first', () => {
    const job = makeJob({ service_type: 'plumbing' });
    const low = makeTechnician({ id: 'low', max_jobs_per_day: 6 });
    const high = makeTechnician({ id: 'high', max_jobs_per_day: 6, skills: ['plumbing'] });
    const result = suggestTechnicians(job, [low, high], {});
    expect(result.map((r) => r.technician.id)).toEqual(['high', 'low']);
  });
});
