import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FunctionsHttpError } from '@supabase/supabase-js';

const invoke = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('@/lib/privacy/i18n', () => ({}));

import { downloadExport } from './dataExports';
import { reauthGate } from '@/lib/session/reauthGate';

const request = vi.spyOn(reauthGate, 'request');

function httpError(code: string) {
  return new FunctionsHttpError(new Response(JSON.stringify({ error: code }), { status: 401 }));
}

beforeEach(() => {
  invoke.mockReset();
  request.mockReset();
  document.body.innerHTML = '';
});

describe('export step-up', () => {
  it('prompts for re-auth once and replays the download', async () => {
    invoke.mockResolvedValueOnce({ data: null, error: httpError('step_up_required') });
    invoke.mockResolvedValueOnce({ data: { url: 'https://signed/x', file_name: 'x.csv' }, error: null });
    request.mockResolvedValue(true);
    await downloadExport('job-1');
    expect(request).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('gives a readable error (not a raw code) when the user cancels re-auth', async () => {
    invoke.mockResolvedValue({ data: null, error: httpError('step_up_required') });
    request.mockResolvedValue(false);
    await expect(downloadExport('job-1')).rejects.toThrow('accessLog:errors.step_up_required');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('maps rate limiting to a friendly message without prompting', async () => {
    invoke.mockResolvedValue({ data: null, error: httpError('rate_limited') });
    await expect(downloadExport('job-1')).rejects.toThrow('accessLog:errors.rate_limited');
    expect(request).not.toHaveBeenCalled();
  });
});
