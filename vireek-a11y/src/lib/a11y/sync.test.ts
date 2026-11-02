import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { decideSync, deleteRemote, fetchRemote, pushRemote, type PrefsClient } from './sync';

const remote = (at: number) => ({ settings: DEFAULT_SETTINGS, updatedAt: at });

describe('decideSync', () => {
  it('no remote → push', () => { expect(decideSync(0, 0, null)).toBe('push'); });
  it('remote newer & local clean → pull', () => { expect(decideSync(100, 50, remote(200))).toBe('pull'); });
  it('remote unchanged & local dirty → push; both clean → none', () => {
    expect(decideSync(200, 300, remote(200))).toBe('push');
    expect(decideSync(200, 100, remote(200))).toBe('none');
  });
  it('conflict: newer edit wins', () => {
    expect(decideSync(100, 400, remote(300))).toBe('push');
    expect(decideSync(100, 250, remote(300))).toBe('pull');
  });
});

function fake(over: Partial<{ data: unknown; error: { message: string } | null }>): PrefsClient {
  const res = Promise.resolve({ data: over.data ?? null, error: over.error ?? null });
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => res as never }) }),
      upsert: () => ({ select: () => ({ single: () => res as never }) }),
      delete: () => ({ eq: () => Promise.resolve({ error: over.error ?? null }) }),
    }),
  };
}

describe('remote helpers', () => {
  it('fetchRemote sanitizes hostile server data', async () => {
    const r = await fetchRemote(fake({ data: { settings: { textSize: 999, colorBlind: 'x' }, updated_at: '2026-10-31T10:00:00Z' } }), 'u');
    expect(r.ok && r.remote?.settings.textSize).toBe(1.5);
    expect(r.ok && r.remote?.settings.colorBlind).toBe('none');
  });
  it('fetchRemote: missing row → null; error surfaces', async () => {
    const none = await fetchRemote(fake({}), 'u');
    expect(none.ok && none.remote).toBe(null);
    const bad = await fetchRemote(fake({ error: { message: 'boom' } }), 'u');
    expect(bad.ok).toBe(false);
  });
  it('pushRemote returns server time; errors do not throw', async () => {
    const ok = await pushRemote(fake({ data: { updated_at: '2026-10-31T10:00:00Z' } }), 'u', DEFAULT_SETTINGS);
    expect(ok.ok && ok.updatedAt).toBe(Date.parse('2026-10-31T10:00:00Z'));
    const bad = await pushRemote(fake({ error: { message: 'rls' } }), 'u', DEFAULT_SETTINGS);
    expect(bad.ok).toBe(false);
    expect((await deleteRemote(fake({ error: { message: 'x' } }), 'u')).ok).toBe(false);
  });
});
