import { describe, expect, it } from 'vitest';
import { describeSync } from './syncStatusModel';

const base = { online: true, syncing: false, pending: 0, failed: 0, conflicts: 0, needsSignIn: false };

describe('describeSync', () => {
  it('all synced', () => expect(describeSync(base)).toMatchObject({ kind: 'synced', tone: 'ok', count: 0 }));
  it('airplane mode with queued work', () => {
    const v = describeSync({ ...base, online: false, pending: 3 });
    expect(v.kind).toBe('offline');
    expect(v.detail).toContain('3 items');
  });
  it('offline with nothing queued still reassures', () => expect(describeSync({ ...base, online: false }).detail).toContain('saved'));
  it('syncing, then waiting', () => {
    expect(describeSync({ ...base, syncing: true, pending: 2 }).kind).toBe('syncing');
    expect(describeSync({ ...base, pending: 1 })).toMatchObject({ kind: 'waiting', label: '1 item waiting to sync' });
  });
  it('priority: sign-in > conflict > failed > offline', () => {
    expect(describeSync({ ...base, online: false, failed: 1, conflicts: 1, needsSignIn: true }).kind).toBe('needs_sign_in');
    expect(describeSync({ ...base, online: false, failed: 1, conflicts: 1 }).kind).toBe('conflict');
    expect(describeSync({ ...base, online: false, failed: 2 }).kind).toBe('failed');
  });
  it('counts everything still on the device', () => expect(describeSync({ ...base, pending: 1, failed: 2, conflicts: 3 }).count).toBe(6));
});
