import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }));

import { supabase } from './supabase';
import { checkOutCribTool, cribErrorMessage } from './toolCrib';

const rpc = vi.mocked(supabase.rpc);
const base = { toolId: 't1', technicianId: 'm1', loanHours: 24, condition: 'good' as const, note: '' };

describe('checkOutCribTool', () => {
  beforeEach(() => rpc.mockReset());

  it('sends the vehicle, defaulting to null', async () => {
    rpc.mockResolvedValue({ data: { loan_id: 'l1', tool_name: 'Drill', technician_name: 'Ana', vehicle_label: null, due_at: 'x' }, error: null } as never);
    await checkOutCribTool(base);
    expect(rpc).toHaveBeenLastCalledWith('check_out_crib_tool', expect.objectContaining({ p_vehicle_id: null }));
    await checkOutCribTool({ ...base, vehicleId: 'v1' });
    expect(rpc).toHaveBeenLastCalledWith('check_out_crib_tool', expect.objectContaining({ p_vehicle_id: 'v1' }));
  });

  it('surfaces a blocked double check-out as a readable message', async () => {
    const blocked = { code: 'P0004', message: 'This tool is already checked out' };
    rpc
      .mockResolvedValueOnce({ data: { loan_id: 'l1', tool_name: 'Drill', technician_name: 'Ana', vehicle_label: null, due_at: 'x' }, error: null } as never)
      .mockResolvedValueOnce({ data: null, error: blocked } as never);
    await checkOutCribTool(base);
    const second = await checkOutCribTool(base).catch((e: unknown) => e);
    expect(cribErrorMessage(second)).toBe('This tool is already checked out');
  });
});
