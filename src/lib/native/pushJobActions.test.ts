import { describe, expect, it, vi } from 'vitest';
import { jobIdFromUrl, runPushJobAction, type ActionDeps } from './pushJobActions';

const ID = '3f2b8c1e-4d5a-4b6c-8d7e-9a0b1c2d3e4f';
const url = `https://vireek.com/tech/job/${ID}`;

const deps = (over: Partial<ActionDeps> = {}): ActionDeps => ({
  hasIdentity: () => true,
  getLocalJobStatus: async () => 'scheduled',
  hasQueuedStatus: async () => false,
  queueStatus: vi.fn(async () => undefined),
  ...over,
});

describe('jobIdFromUrl', () => {
  it('accepts absolute and relative job links', () => {
    expect(jobIdFromUrl(url)).toBe(ID);
    expect(jobIdFromUrl(`/tech/job/${ID}`)).toBe(ID);
  });
  it('rejects other hosts, paths, junk and non-strings', () => {
    expect(jobIdFromUrl(`https://evil.com/tech/job/${ID}`)).toBeNull();
    expect(jobIdFromUrl('/tech/job/not-a-uuid')).toBeNull();
    expect(jobIdFromUrl(`/tech/job/${ID}/../../admin`)).toBeNull();
    expect(jobIdFromUrl(null)).toBeNull();
    expect(jobIdFromUrl(42)).toBeNull();
  });
});

describe('runPushJobAction', () => {
  it('queues en_route and start', async () => {
    const d = deps();
    expect(await runPushJobAction({ actionId: 'en_route', data: { url } }, d)).toEqual({ kind: 'queued', jobId: ID, status: 'en_route' });
    expect(d.queueStatus).toHaveBeenCalledWith(ID, 'en_route');
    const s = deps({ getLocalJobStatus: async () => 'en_route' });
    expect((await runPushJobAction({ actionId: 'start', data: { url } }, s)).kind).toBe('queued');
  });
  it('never completes directly while the flag is off', async () => {
    const d = deps({ getLocalJobStatus: async () => 'in_progress' });
    expect(await runPushJobAction({ actionId: 'complete', data: { url } }, d)).toEqual({ kind: 'open', jobId: ID });
    expect(d.queueStatus).not.toHaveBeenCalled();
  });
  it('ignores unknown actions, missing jobs, no identity, foreign jobs', async () => {
    expect(await runPushJobAction({ actionId: 'delete', data: { url } }, deps())).toEqual({ kind: 'ignored', reason: 'unknown_action' });
    expect(await runPushJobAction({ actionId: 'start', data: {} }, deps())).toEqual({ kind: 'ignored', reason: 'no_job' });
    expect(await runPushJobAction({ actionId: 'start', data: { url } }, deps({ hasIdentity: () => false }))).toEqual({ kind: 'ignored', reason: 'no_identity' });
    expect(await runPushJobAction({ actionId: 'start', data: { url } }, deps({ getLocalJobStatus: async () => null }))).toEqual({ kind: 'ignored', reason: 'not_my_job' });
  });
  it('is forward-only and idempotent', async () => {
    const back = deps({ getLocalJobStatus: async () => 'in_progress' });
    expect(await runPushJobAction({ actionId: 'en_route', data: { url } }, back)).toEqual({ kind: 'ignored', reason: 'not_forward' });
    const dup = deps({ hasQueuedStatus: async () => true });
    expect(await runPushJobAction({ actionId: 'start', data: { url } }, dup)).toEqual({ kind: 'ignored', reason: 'already_queued' });
    expect(dup.queueStatus).not.toHaveBeenCalled();
  });
});
