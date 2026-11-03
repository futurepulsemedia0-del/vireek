import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadVoiceOverride, PRESET_VOICE_MAP, resolveVoice, type VoiceRow } from './voiceOverride';
import { deleteElevenLabsVoice } from './elevenLabs';

const CLONE = 'xYz123AbC456dEf789Gh';
const ready = (over: Partial<VoiceRow> = {}): VoiceRow => ({
  assistant_voice: 'sarah-warm-f-us',
  use_custom_voice: true,
  custom_voice_id: CLONE,
  custom_voice_status: 'ready',
  custom_voice_consent_at: '2028-11-02T10:00:00Z',
  custom_voice_consent_by: 'owner-a',
  ...over,
});

type Row = VoiceRow & { user_id: string };
/** Minimal stand-in for supabase-js: select().eq(col, val).maybeSingle() filtering like the real query. */
function fakeAdmin(rows: Row[], opts: { error?: boolean } = {}) {
  return {
    from: () => ({
      select: () => ({
        eq: (col: keyof Row, val: string) => ({
          maybeSingle: async () => ({
            data: opts.error ? null : (rows.find((r) => r[col] === val) ?? null),
            error: opts.error ? { message: 'db down' } : null,
          }),
        }),
      }),
    }),
  } as never;
}
const allow = async () => true;

afterEach(() => vi.restoreAllMocks());

describe('resolveVoice', () => {
  it('uses the clone when selected, ready, consented and allowed', () => {
    expect(resolveVoice(ready(), true)).toEqual({ voice: { provider: '11labs', voiceId: CLONE }, source: 'custom' });
  });

  it('falls back to the preset when the clone was not selected', () => {
    expect(resolveVoice(ready({ use_custom_voice: false }), true)).toEqual({ voice: null, source: 'preset' });
  });

  it.each([
    ['status processing', ready({ custom_voice_status: 'processing' }), true, 'clone_not_ready'],
    ['status failed', ready({ custom_voice_status: 'failed' }), true, 'clone_not_ready'],
    ['status none', ready({ custom_voice_status: 'none' }), true, 'clone_not_ready'],
    ['missing voice id', ready({ custom_voice_id: null }), true, 'clone_id_invalid'],
    ['malformed voice id', ready({ custom_voice_id: 'x"; drop table' }), true, 'clone_id_invalid'],
    ['no consent timestamp', ready({ custom_voice_consent_at: null }), true, 'consent_missing'],
    ['no consent user', ready({ custom_voice_consent_by: null }), true, 'consent_missing'],
    ['feature gate off', ready(), false, 'clone_disabled'],
  ] as const)('falls back to the preset: %s', (_n, row, allowed, reason) => {
    const r = resolveVoice(row, allowed);
    expect(r.source).toBe('preset');
    expect(r.voice).toBeNull();
    expect(r.fallbackReason).toBe(reason);
  });

  it('only ever references the six DB-constrained preset ids', () => {
    expect(Object.keys(PRESET_VOICE_MAP).sort()).toEqual(
      ['aria-friendly-f-us', 'jay-easygoing-m-us', 'maya-calm-f-uk', 'miles-confident-m-us', 'oliver-polished-m-uk', 'sarah-warm-f-us'],
    );
  });
});

describe('loadVoiceOverride: fallback', () => {
  it('returns the clone for the owner', async () => {
    const admin = fakeAdmin([{ user_id: 'owner-a', ...ready() }]);
    expect(await loadVoiceOverride(admin, 'owner-a', { cloneAllowed: allow })).toEqual({ voice: { provider: '11labs', voiceId: CLONE } });
  });

  it('returns {} (assistant default voice) when the clone is missing', async () => {
    const admin = fakeAdmin([{ user_id: 'owner-a', ...ready({ custom_voice_id: null, custom_voice_status: 'none' }) }]);
    expect(await loadVoiceOverride(admin, 'owner-a', { cloneAllowed: allow })).toEqual({});
  });

  it('returns {} when there is no business_profile row', async () => {
    expect(await loadVoiceOverride(fakeAdmin([]), 'owner-a', { cloneAllowed: allow })).toEqual({});
  });

  it('returns {} and does not throw when the database errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await loadVoiceOverride(fakeAdmin([], { error: true }), 'owner-a', { cloneAllowed: allow })).toEqual({});
  });

  it('returns {} when the gate lookup throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const admin = fakeAdmin([{ user_id: 'owner-a', ...ready() }]);
    const boom = async () => { throw new Error('rpc failed'); };
    expect(await loadVoiceOverride(admin, 'owner-a', { cloneAllowed: boom })).toEqual({});
  });

  it('returns {} when the lookup is slower than the timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const admin = fakeAdmin([{ user_id: 'owner-a', ...ready() }]);
    const never = () => new Promise<boolean>(() => undefined);
    expect(await loadVoiceOverride(admin, 'owner-a', { cloneAllowed: never, timeoutMs: 20 })).toEqual({});
  });

  it('skips the gate lookup when the clone is not selected', async () => {
    const gate = vi.fn(async () => true);
    const admin = fakeAdmin([{ user_id: 'owner-a', ...ready({ use_custom_voice: false }) }]);
    expect(await loadVoiceOverride(admin, 'owner-a', { cloneAllowed: gate })).toEqual({});
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('loadVoiceOverride: tenant ownership', () => {
  const rows: Row[] = [
    { user_id: 'owner-a', ...ready({ custom_voice_id: 'voiceAAAAAAAA1111', custom_voice_consent_by: 'owner-a' }) },
    { user_id: 'owner-b', ...ready({ custom_voice_id: 'voiceBBBBBBBB2222', custom_voice_consent_by: 'owner-b' }) },
    { user_id: 'owner-c', ...ready({ use_custom_voice: false, custom_voice_id: 'voiceCCCCCCCC3333', custom_voice_consent_by: 'owner-c' }) },
  ];
  const admin = fakeAdmin(rows);

  it("each tenant only ever receives its own voice id", async () => {
    expect(await loadVoiceOverride(admin, 'owner-a', { cloneAllowed: allow })).toEqual({ voice: { provider: '11labs', voiceId: 'voiceAAAAAAAA1111' } });
    expect(await loadVoiceOverride(admin, 'owner-b', { cloneAllowed: allow })).toEqual({ voice: { provider: '11labs', voiceId: 'voiceBBBBBBBB2222' } });
  });

  it("a tenant that did not select its clone never gets it, nor anyone else's", async () => {
    expect(await loadVoiceOverride(admin, 'owner-c', { cloneAllowed: allow })).toEqual({});
  });

  it('an unknown tenant gets nothing even though other tenants have clones', async () => {
    expect(await loadVoiceOverride(admin, 'owner-z', { cloneAllowed: allow })).toEqual({});
  });

  it('checks the gate for the requested owner only', async () => {
    const gate = vi.fn(async () => true);
    await loadVoiceOverride(admin, 'owner-b', { cloneAllowed: gate });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0][1]).toBe('owner-b');
  });
});

describe('deleteElevenLabsVoice', () => {
  const call = (status: number, spy = vi.fn()) => {
    const f = (async (...a: unknown[]) => { spy(...a); return new Response('{}', { status }); }) as unknown as typeof fetch;
    return { f, spy };
  };

  it('200 -> deleted, using DELETE with the key header and an encoded id', async () => {
    const { f, spy } = call(200);
    expect(await deleteElevenLabsVoice('sk_test', CLONE, f)).toBe('deleted');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.elevenlabs.io/v1/voices/${CLONE}`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('sk_test');
  });

  it('404 -> not_found (treated as already deleted)', async () => {
    expect(await deleteElevenLabsVoice('sk_test', CLONE, call(404).f)).toBe('not_found');
  });

  it('401/500 -> failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await deleteElevenLabsVoice('sk_test', CLONE, call(401).f)).toBe('failed');
    expect(await deleteElevenLabsVoice('sk_test', CLONE, call(500).f)).toBe('failed');
  });

  it('refuses a malformed id or empty key without calling the network', async () => {
    const { f, spy } = call(200);
    expect(await deleteElevenLabsVoice('sk_test', '../../voices', f)).toBe('failed');
    expect(await deleteElevenLabsVoice('', CLONE, f)).toBe('failed');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a network error -> failed, never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await deleteElevenLabsVoice('sk_test', CLONE, f)).toBe('failed');
  });
});
