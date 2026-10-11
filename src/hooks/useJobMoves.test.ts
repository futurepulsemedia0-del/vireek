import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { Job } from '@/lib/supabase';

const toast = vi.fn();
const moveJob = vi.fn();

vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/scheduleDndApi', () => ({ moveJob: (...a: unknown[]) => moveJob(...a) }));

import { useJobMoves } from './useJobMoves';

const base = {
  id: 'j1',
  customer_name: 'Jane',
  scheduled_datetime: '2026-10-12T09:00:00.000Z',
  assigned_technician_id: 't1',
  job_status: 'scheduled',
  duration_minutes: 60,
} as Job;

function setup(initial: Job[] = [base]) {
  return renderHook(() => {
    const [jobs, setJobs] = useState<Job[]>(initial);
    const moves = useJobMoves({ jobs, setJobs, enableShortcut: false });
    return { jobs, moves };
  });
}

beforeEach(() => {
  toast.mockReset();
  moveJob.mockReset();
});

describe('useJobMoves', () => {
  it('applies optimistically, adopts the server row and offers Undo', async () => {
    let resolve!: (v: unknown) => void;
    moveJob.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = setup();

    let done!: Promise<boolean>;
    act(() => {
      done = result.current.moves.commit('j1', { assigned_technician_id: 't2' }, { successMessage: 'Moved.' });
    });
    expect(result.current.jobs[0].assigned_technician_id).toBe('t2'); // optimistic
    expect(result.current.moves.isPending('j1')).toBe(true);

    await act(async () => {
      resolve({ status: 'moved', job: { ...base, assigned_technician_id: 't2' } });
      await done;
    });
    expect(moveJob).toHaveBeenCalledWith('j1', { assigned_technician_id: 't2' }, expect.objectContaining({ assigned_technician_id: 't1' }));
    expect(result.current.moves.isPending('j1')).toBe(false);
    expect(toast).toHaveBeenCalledWith('Moved.', 'success', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }));
  });

  it('rolls back and explains when the server refuses (capacity)', async () => {
    moveJob.mockResolvedValue({ status: 'at_capacity', reason: 'Tech Two already has 6 of 6 jobs that day.' });
    const { result } = setup();
    await act(async () => {
      await result.current.moves.commit('j1', { assigned_technician_id: 't2' }, { successMessage: 'Moved.' });
    });
    expect(result.current.jobs[0].assigned_technician_id).toBe('t1');
    expect(toast).toHaveBeenCalledWith('Tech Two already has 6 of 6 jobs that day.', 'error');
  });

  it('adopts the latest server row when someone else changed the job (stale)', async () => {
    moveJob.mockResolvedValue({ status: 'stale', reason: 'Someone else changed this job.', job: { ...base, assigned_technician_id: 't9' } });
    const { result } = setup();
    await act(async () => {
      await result.current.moves.commit('j1', { assigned_technician_id: 't2' }, { successMessage: 'Moved.' });
    });
    expect(result.current.jobs[0].assigned_technician_id).toBe('t9');
  });

  it('rolls back and surfaces mapped errors when the RPC throws', async () => {
    moveJob.mockRejectedValue(new Error('boom'));
    const { result } = setup();
    await act(async () => {
      await result.current.moves.commit('j1', { job_status: 'en_route' }, { successMessage: 'Moved.' });
    });
    expect(result.current.jobs[0].job_status).toBe('scheduled');
    expect(toast).toHaveBeenCalledWith('boom', 'error');
  });

  it('undo sends the inverse patch guarded by the post-move state', async () => {
    moveJob.mockResolvedValueOnce({ status: 'moved', job: { ...base, assigned_technician_id: 't2' } });
    const { result } = setup();
    await act(async () => {
      await result.current.moves.commit('j1', { assigned_technician_id: 't2' }, { successMessage: 'Moved.' });
    });
    moveJob.mockResolvedValueOnce({ status: 'moved', job: base });
    await act(async () => {
      result.current.moves.undoLast();
    });
    expect(moveJob).toHaveBeenLastCalledWith('j1', { assigned_technician_id: 't1' }, expect.objectContaining({ assigned_technician_id: 't2' }));
    expect(result.current.jobs[0].assigned_technician_id).toBe('t1');
  });
});
