import { describe, expect, it } from 'vitest';
import { VapiEngine, VAPI_CALL_URL, classifyVapiEvent } from './vapiEngine.ts';
import { OpenAiRealtimeEngine } from './openAiRealtimeEngine.ts';
import { resolveVoiceEngine, OPENAI_REALTIME_KILL_SWITCH_ENV } from './resolve.ts';
import type { VoiceEngine } from './types.ts';

// ---------------------------------------------------------------------------
// Characterization: the request outbound-dialer sent INLINE before the adapter
// existed (copied verbatim from the original source). The adapter must produce
// exactly this, byte for byte.
// ---------------------------------------------------------------------------
function legacyDialerRequest(vapiKey: string, assistantId: string, phoneNumberId: string, phone: string, name: string, purpose: string) {
  return {
    url: 'https://api.vapi.ai/call',
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${vapiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: { number: phone },
        assistantOverrides: { variableValues: { customer_name: name, call_purpose: purpose } },
      }),
    },
  };
}

interface Seen { url: string; init: RequestInit | undefined }
function fakeFetch(res: Response | (() => Promise<Response>), seen: Seen[]) {
  return (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return typeof res === 'function' ? res() : Promise.resolve(res);
  };
}

const INPUT = {
  ownerId: 'owner-1',
  assistantId: 'asst_123',
  phoneNumberId: 'pn_456',
  customerNumber: '+15552010001',
  variableValues: { customer_name: 'Ana', call_purpose: 'quote_followup' },
};

describe('VapiEngine.startCall — identical to the legacy inline dialer request', () => {
  it('sends the same URL, method, headers and body bytes', async () => {
    const seen: Seen[] = [];
    const eng = new VapiEngine({ apiKey: 'k_test', fetchImpl: fakeFetch(new Response(JSON.stringify({ id: 'call_1' }), { status: 201 }), seen) });
    await eng.startCall(INPUT);
    const legacy = legacyDialerRequest('k_test', 'asst_123', 'pn_456', '+15552010001', 'Ana', 'quote_followup');
    expect(VAPI_CALL_URL).toBe('https://api.vapi.ai/call');
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe(legacy.url);
    expect(seen[0].init?.method).toBe(legacy.init.method);
    expect(seen[0].init?.headers).toEqual(legacy.init.headers);
    expect(seen[0].init?.body).toBe(legacy.init.body);
  });

  it('returns the Vapi call id on success', async () => {
    const eng = new VapiEngine({ apiKey: 'k', fetchImpl: fakeFetch(new Response(JSON.stringify({ id: 'call_9' })), []) });
    expect(await eng.startCall(INPUT)).toEqual({ ok: true, engine: 'vapi', callId: 'call_9' });
  });

  it('returns callId null when Vapi omits id (legacy `json.id ?? null`)', async () => {
    const eng = new VapiEngine({ apiKey: 'k', fetchImpl: fakeFetch(new Response(JSON.stringify({})), []) });
    expect(await eng.startCall(INPUT)).toEqual({ ok: true, engine: 'vapi', callId: null });
  });

  it('builds the legacy error note: "Vapi error <status>: <first 300 chars>"', async () => {
    const long = 'x'.repeat(500);
    const eng = new VapiEngine({ apiKey: 'k', fetchImpl: fakeFetch(new Response(long, { status: 402 }), []) });
    const r = await eng.startCall(INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(402);
      expect(r.note).toBe(`Vapi error 402: ${'x'.repeat(300)}`);
    }
  });

  it('does NOT swallow network errors (caller try/catch keeps its behavior)', async () => {
    const eng = new VapiEngine({ apiKey: 'k', fetchImpl: () => Promise.reject(new Error('socket hang up')) });
    await expect(eng.startCall(INPUT)).rejects.toThrow('socket hang up');
  });

  it('does NOT swallow invalid JSON on a 2xx (legacy `await res.json()` threw)', async () => {
    const eng = new VapiEngine({ apiKey: 'k', fetchImpl: fakeFetch(new Response('not json', { status: 200 }), []) });
    await expect(eng.startCall(INPUT)).rejects.toThrow();
  });

  it('isReady only with an API key', () => {
    expect(new VapiEngine({ apiKey: 'k' }).isReady()).toBe(true);
    expect(new VapiEngine({ apiKey: '' }).isReady()).toBe(false);
    expect(new VapiEngine({ apiKey: null }).isReady()).toBe(false);
  });
});

describe('VapiEngine — operations that do not exist today are explicit, not invented', () => {
  const eng = new VapiEngine({ apiKey: 'k' });
  it('applyVoice / endCall are unsupported', async () => {
    const v = await eng.applyVoice({ ownerId: 'o', assistantId: 'a', voiceId: 'v' });
    const e = await eng.endCall({ ownerId: 'o', callId: 'c' });
    expect(v.ok).toBe(false);
    expect(e.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('unsupported');
    if (!e.ok) expect(e.reason).toBe('unsupported');
  });
  it('handleEvent never handles — vapi-webhook stays the single owner', async () => {
    const r = await eng.handleEvent({ engine: 'vapi', kind: 'tool-calls', type: 'tool-calls', raw: {} });
    expect(r).toEqual({ handled: false, reason: 'owned_by_existing_webhook' });
  });
  it('classifyVapiEvent maps known types and defaults to other', () => {
    expect(classifyVapiEvent('assistant-request')).toBe('assistant-request');
    expect(classifyVapiEvent('tool-calls')).toBe('tool-calls');
    expect(classifyVapiEvent('transfer-destination-request')).toBe('transfer-destination-request');
    expect(classifyVapiEvent('end-of-call-report')).toBe('call-lifecycle');
    expect(classifyVapiEvent('status-update')).toBe('call-lifecycle');
    expect(classifyVapiEvent('whatever')).toBe('other');
  });
});

describe('OpenAiRealtimeEngine stub', () => {
  it('is never ready and never touches the network', async () => {
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => { fetchCalls += 1; return Promise.reject(new Error('network must not be used')); }) as typeof fetch;
    try {
      const eng = new OpenAiRealtimeEngine();
      expect(eng.isReady()).toBe(false);
      const s = await eng.startCall(INPUT);
      expect(s.ok).toBe(false);
      if (!s.ok) { expect(s.engine).toBe('openai_realtime'); expect(s.status).toBe(0); }
      expect((await eng.applyVoice({ ownerId: 'o', assistantId: 'a', voiceId: 'v' })).ok).toBe(false);
      expect((await eng.endCall({ ownerId: 'o', callId: 'c' })).ok).toBe(false);
      expect(await eng.handleEvent({ engine: 'openai_realtime', kind: 'other', type: 'x', raw: null })).toEqual({ handled: false, reason: 'not_implemented' });
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------
// Test double: the stub, but pretending to be production-ready. Proves the flag path works.
class ReadyOpenAi extends OpenAiRealtimeEngine {
  override isReady(): boolean { return true; }
}
function readyOpenAi(): VoiceEngine {
  return new ReadyOpenAi();
}

function mk(opts: { env?: Record<string, string>; flag?: string | null | Error; openai?: VoiceEngine; envThrows?: boolean }) {
  let loadCalls = 0;
  const vapi = new VapiEngine({ apiKey: 'k' });
  const openai = opts.openai ?? new OpenAiRealtimeEngine();
  const deps = {
    ownerId: 'owner-1',
    getEnv: (k: string) => { if (opts.envThrows) throw new Error('env'); return (opts.env ?? {})[k]; },
    loadFlag: async () => {
      loadCalls += 1;
      if (opts.flag instanceof Error) throw opts.flag;
      return opts.flag ?? null;
    },
    engines: { vapi, openai_realtime: openai },
  };
  return { deps, calls: () => loadCalls };
}
const ON = { [OPENAI_REALTIME_KILL_SWITCH_ENV]: 'true' };

describe('resolveVoiceEngine — Vapi is default and unchanged when the flag is off', () => {
  it('no env -> Vapi and the flag store is NOT queried', async () => {
    const t = mk({ flag: 'openai_realtime' });
    const r = await resolveVoiceEngine(t.deps);
    expect(r.selected).toBe('vapi');
    expect(r.reason).toBe('kill_switch_off');
    expect(t.calls()).toBe(0);
  });
  it.each(['false', 'TRUE', '1', 'yes', ''])('kill switch value %j -> Vapi, no query', async (v) => {
    const t = mk({ env: { [OPENAI_REALTIME_KILL_SWITCH_ENV]: v }, flag: 'openai_realtime' });
    const r = await resolveVoiceEngine(t.deps);
    expect(r.selected).toBe('vapi');
    expect(t.calls()).toBe(0);
  });
  it('kill switch on but tenant has no row -> Vapi', async () => {
    const r = await resolveVoiceEngine(mk({ env: ON, flag: null }).deps);
    expect(r.selected).toBe('vapi');
    expect(r.reason).toBe('flag_not_openai');
  });
  it('kill switch on, tenant row says vapi -> Vapi', async () => {
    expect((await resolveVoiceEngine(mk({ env: ON, flag: 'vapi' }).deps)).selected).toBe('vapi');
  });
  it('garbage flag value -> Vapi', async () => {
    expect((await resolveVoiceEngine(mk({ env: ON, flag: 'gpt-live' }).deps)).selected).toBe('vapi');
  });
  it('flag lookup throws -> Vapi (never throws)', async () => {
    const r = await resolveVoiceEngine(mk({ env: ON, flag: new Error('relation does not exist') }).deps);
    expect(r.selected).toBe('vapi');
    expect(r.reason).toBe('flag_lookup_failed');
  });
  it('env read throws -> Vapi (never throws)', async () => {
    expect((await resolveVoiceEngine(mk({ envThrows: true, flag: 'openai_realtime' }).deps)).selected).toBe('vapi');
  });
  it('kill switch ON + tenant flag ON but engine is the stub -> STILL Vapi', async () => {
    const r = await resolveVoiceEngine(mk({ env: ON, flag: 'openai_realtime' }).deps);
    expect(r.selected).toBe('vapi');
    expect(r.reason).toBe('engine_not_ready');
  });
  it('proves the flag path itself works: all three conditions + a ready engine -> OpenAI', async () => {
    const r = await resolveVoiceEngine(mk({ env: ON, flag: 'openai_realtime', openai: readyOpenAi() }).deps);
    expect(r.selected).toBe('openai_realtime');
    expect(r.reason).toBe('flag_enabled');
  });
  it('a ready engine is still not used when the tenant flag is off', async () => {
    const r = await resolveVoiceEngine(mk({ env: ON, flag: 'vapi', openai: readyOpenAi() }).deps);
    expect(r.selected).toBe('vapi');
  });
});
