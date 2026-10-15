import { describe, it, expect } from 'vitest';
import { suggestTechnicians } from './dispatch';
import { EMPTY_AVAILABILITY, type AvailabilityData } from './timeOff';
import type { Job, TeamMember } from '@/lib/supabase';

// Local-noon timestamp: the local calendar day is identical in every timezone.
const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();

function tech(id: string): TeamMember {
  return {
    id,
    role: 'technician',
    dispatch_enabled: true,
    max_jobs_per_day: 6,
    skills: [],
    service_area: null,
  } as unknown as TeamMember;
}

function jobOn(day: string): Job {
  return { id: 'job-1', service_type: null, address: null, scheduled_datetime: noon(day) } as unknown as Job;
}

const availability = (over: Partial<AvailabilityData>): AvailabilityData => ({ ...EMPTY_AVAILABILITY, ...over });

const pto = {
  id: 'o1',
  user_id: 'owner',
  technician_id: 'alex',
  kind: 'pto' as const,
  start_date: '2026-06-10',
  end_date: '2026-06-12',
  note: null,
  status: 'approved' as const,
  created_by: 'owner',
  created_at: '',
  updated_at: '',
};

describe('suggestTechnicians + availability', () => {
  it('behaves exactly as before when no availability data is passed', () => {
    const result = suggestTechnicians(jobOn('2026-06-11'), [tech('alex'), tech('sam')], {});
    expect(result.map((s) => s.technician.id).sort()).toEqual(['alex', 'sam']);
  });

  it('drops a technician who is on approved time off that day', () => {
    const result = suggestTechnicians(jobOn('2026-06-11'), [tech('alex'), tech('sam')], {}, {}, {}, availability({ timeOff: [pto] }));
    expect(result.map((s) => s.technician.id)).toEqual(['sam']);
  });

  it('keeps everyone on days outside the entry and ignores cancelled entries', () => {
    const outside = suggestTechnicians(jobOn('2026-06-13'), [tech('alex')], {}, {}, {}, availability({ timeOff: [pto] }));
    expect(outside).toHaveLength(1);
    const cancelled = suggestTechnicians(jobOn('2026-06-11'), [tech('alex')], {}, {}, {}, availability({ timeOff: [{ ...pto, status: 'cancelled' }] }));
    expect(cancelled).toHaveLength(1);
  });

  it('returns nobody on a company blackout day', () => {
    const blackout = {
      id: 'b1',
      user_id: 'owner',
      label: 'Holiday',
      start_date: '2026-06-11',
      end_date: '2026-06-11',
      status: 'active' as const,
      created_by: 'owner',
      created_at: '',
      updated_at: '',
    };
    expect(suggestTechnicians(jobOn('2026-06-11'), [tech('alex'), tech('sam')], {}, {}, {}, availability({ blackouts: [blackout] }))).toEqual([]);
  });

  it('skips technicians who do not work that weekday', () => {
    // 2026-06-14 is a Sunday.
    const result = suggestTechnicians(jobOn('2026-06-14'), [tech('alex'), tech('sam')], {}, {}, {}, availability({ weekly: { alex: [1, 2, 3, 4, 5] } }));
    expect(result.map((s) => s.technician.id)).toEqual(['sam']);
  });
});
