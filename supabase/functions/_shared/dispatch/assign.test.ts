import { describe, it, expect, vi } from 'vitest';
import { assignBestTechnician } from './assign';

function makeAdmin(rpcResult: { data?: unknown; error?: { message: string } | null }) {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as any;
}

const job = { id: 'job-1', service_type: 'plumbing', address: '123 Main St', scheduled_datetime: '2026-09-24T14:00:00.000Z' };

describe('assignBestTechnician', () => {
  it('returns the assigned technician when the RPC succeeds', async () => {
    const admin = makeAdmin({
      data: { status: 'assigned', technician_id: 'tech-1', technician_name: 'Alex Rivera' },
      error: null,
    });
    const result = await assignBestTechnician(admin, 'user-1', job);

    expect(result).toEqual({
      technicianId: 'tech-1',
      technicianName: 'Alex Rivera',
      reason: 'Assigned by AI Dispatcher — best skill/service-area/capacity match.',
    });
    expect(admin.rpc).toHaveBeenCalledWith('assign_technician_to_job', { p_job_id: 'job-1', p_technician_id: null });
  });

  it('returns a null assignment with the reason when no technician matches', async () => {
    const admin = makeAdmin({ data: { status: 'no_match', reason: 'No technician covers this service area.' }, error: null });
    const result = await assignBestTechnician(admin, 'user-1', job);

    expect(result.technicianId).toBeNull();
    expect(result.reason).toBe('No technician covers this service area.');
  });

  it('falls back to a generic reason when the RPC reports failure without one', async () => {
    const admin = makeAdmin({ data: { status: 'no_match' }, error: null });
    const result = await assignBestTechnician(admin, 'user-1', job);
    expect(result.reason).toBe('No technician available.');
  });

  it('surfaces the RPC error message instead of throwing, when the RPC call itself fails', async () => {
    const admin = makeAdmin({ data: null, error: { message: 'function assign_technician_to_job does not exist' } });
    const result = await assignBestTechnician(admin, 'user-1', job);

    expect(result.technicianId).toBeNull();
    expect(result.reason).toBe('function assign_technician_to_job does not exist');
  });
});
