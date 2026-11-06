import { describe, it, expect } from 'vitest';
import {
  createVersionedRouter, createVersionResolver, parseResolved, parseRoute, parseSuffix, textSimilarity, withSuffix,
  NO_VERSIONS, type Resolved, type ShadowRecord, type RunFn,
} from './versionedRouting.ts';

const req = { system: 'Base system.', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 } as never;
const resp = (text: string) => ({ response: { text, provider: 'gemini', model: 'm', latencyMs: 1, wasFallback: false } }) as never;

function harness(o: { resolved?: Partial<Record<'prompt' | 'route', Resolved>>; run?: RunFn; rand?: number; record?: ShadowRecord[] }) {
  const calls: Array<{ system: string; route?: unknown }> = [];
  const run: RunFn = o.run ?? (async (_t, r, _a, route) => { calls.push({ system: r.system, route }); return resp('hello world'); });
  const jobs: Promise<unknown>[] = [];
  const records = o.record ?? [];
  const route = createVersionedRouter({
    run,
    resolve: async (k) => o.resolved?.[k] ?? NO_VERSIONS,
    recordShadow: async (r) => { records.push(r); },
    rand: () => o.rand ?? 0,
    waitUntil: (p) => { jobs.push(p); },
  });
  return { route: () => route('chat' as never, req), calls, jobs, records };
}

const active = (payload: unknown, version = 3): Resolved => ({ stopped: false, active: { version, payload }, shadow: null });
const shadowOf = (payload: unknown, samplePct = 100, version = 4): Resolved => ({ stopped: false, active: null, shadow: { version, payload, samplePct } });

describe('parsing', () => {
  it('parseResolved tolerates garbage and honours the stop flag', () => {
    expect(parseResolved(null)).toEqual(NO_VERSIONS);
    expect(parseResolved({ stopped: true, active: { version: 1, payload: {} } }).active).toBeNull();
    expect(parseResolved({ active: { version: 0, payload: {} } }).active).toBeNull();
    expect(parseResolved({ shadow: { version: 2, payload: {}, sample_pct: 90 } }).shadow?.samplePct).toBe(25);
    expect(parseResolved({ shadow: { version: 2, payload: {}, sample_pct: 0 } }).shadow).toBeNull();
  });
  it('validates suffix and route payloads', () => {
    expect(parseSuffix({ system_suffix: '  Be brief. ' })).toBe('Be brief.');
    expect(parseSuffix({ system_suffix: '' })).toBeNull();
    expect(parseRoute({ route: [{ provider: 'groq', model: 'x' }] })?.[0].priority).toBe(10);
    expect(parseRoute({ route: [] })).toBeNull();
    expect(parseRoute({ route: [{ provider: 'groq' }] })).toBeNull();
  });
  it('withSuffix appends to the system prompt', () => {
    expect((withSuffix(req, 'Extra.') as { system: string }).system).toBe('Base system.\n\nExtra.');
  });
  it('textSimilarity is symmetric, bounded and handles empties', () => {
    expect(textSimilarity('a b c', 'a b c')).toBe(1);
    expect(textSimilarity('a b', 'c d')).toBe(0);
    expect(textSimilarity('', '')).toBe(1);
    expect(textSimilarity('a b c d', 'a b')).toBe(textSimilarity('a b', 'a b c d'));
  });
});

describe('versioned router', () => {
  it('uses code defaults when nothing is resolved', async () => {
    const h = harness({});
    await h.route();
    expect(h.calls).toEqual([{ system: 'Base system.', route: undefined }]);
  });

  it('applies the active prompt suffix and route', async () => {
    const h = harness({ resolved: { prompt: active({ system_suffix: 'Be brief.' }), route: active({ route: [{ provider: 'groq', model: 'x' }] }) } });
    await h.route();
    expect(h.calls[0].system).toBe('Base system.\n\nBe brief.');
    expect(h.calls[0].route).toEqual([{ provider: 'groq', model: 'x', priority: 10 }]);
  });

  it('falls back to the pinned baseline when the versioned attempt fails', async () => {
    let n = 0;
    const seen: Array<unknown> = [];
    const run: RunFn = async (_t, _r, _a, route) => { n += 1; seen.push(route); if (route) throw new Error('boom'); return resp('ok'); };
    const h = harness({ run, resolved: { route: active({ route: [{ provider: 'groq', model: 'x' }] }) } });
    const out = await h.route();
    expect(n).toBe(2);
    expect(seen[1]).toBeUndefined();
    expect((out as { response: { text: string } }).response.text).toBe('ok');
  });

  it('still throws when the baseline itself fails', async () => {
    const run: RunFn = async () => { throw new Error('down'); };
    const h = harness({ run });
    let threw = false;
    try { await h.route(); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('runs a sampled shadow candidate and records metrics without changing the answer', async () => {
    const h = harness({ resolved: { prompt: shadowOf({ system_suffix: 'Candidate.' }) } });
    const out = await h.route();
    await Promise.all(h.jobs);
    expect((out as { response: { text: string } }).response.text).toBe('hello world');
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ kind: 'prompt', candidateVersion: 4, candidateOk: true, similarity: 1 });
    expect(h.calls[1].system).toContain('Candidate.');
  });

  it('does not shadow outside the sample', async () => {
    const h = harness({ rand: 0.99, resolved: { prompt: shadowOf({ system_suffix: 'C.' }, 5) } });
    await h.route();
    await Promise.all(h.jobs);
    expect(h.records).toHaveLength(0);
  });

  it('records a failing candidate as data and never throws', async () => {
    const run: RunFn = async (_t, r) => { if (r.system.includes('Candidate')) throw new Error('bad'); return resp('x'); };
    const h = harness({ run, resolved: { prompt: shadowOf({ system_suffix: 'Candidate.' }) } });
    await h.route();
    await Promise.all(h.jobs);
    expect(h.records[0].candidateOk).toBe(false);
    expect(h.records[0].similarity).toBeNull();
  });

  it('shadow route candidate uses the candidate route', async () => {
    const h = harness({ resolved: { route: shadowOf({ route: [{ provider: 'cerebras', model: 'y' }] }) } });
    await h.route();
    await Promise.all(h.jobs);
    expect(h.calls[1].route).toEqual([{ provider: 'cerebras', model: 'y', priority: 10 }]);
  });

  it('returns the production answer before the shadow call finishes', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const run: RunFn = async (_t, r) => { if (r.system.includes('Candidate')) await gate; return resp('prod'); };
    const h = harness({ run, resolved: { prompt: shadowOf({ system_suffix: 'Candidate.' }) } });
    const out = await h.route();
    expect((out as { response: { text: string } }).response.text).toBe('prod');
    expect(h.records).toHaveLength(0);
    release();
    await Promise.all(h.jobs);
    expect(h.records).toHaveLength(1);
  });
});

describe('version resolver', () => {
  it('fails to code defaults when the RPC fails with nothing cached', async () => {
    const resolve = createVersionResolver({ rpc: async () => ({ data: null, error: { message: 'x' } }) });
    expect(await resolve('prompt', 't')).toEqual(NO_VERSIONS);
  });
  it('caches, then serves stale briefly, then defaults', async () => {
    let t = 0;
    let fail = false;
    let calls = 0;
    const resolve = createVersionResolver({
      now: () => t, ttlMs: 1000, maxStaleMs: 5000,
      rpc: async () => { calls += 1; return fail ? { data: null, error: { message: 'x' } } : { data: { active: { version: 2, payload: { system_suffix: 'S' } } }, error: null }; },
    });
    expect((await resolve('prompt', 't')).active?.version).toBe(2);
    await resolve('prompt', 't');
    expect(calls).toBe(1);
    fail = true; t = 2000;
    expect((await resolve('prompt', 't')).active?.version).toBe(2);
    t = 9000;
    expect((await resolve('prompt', 't')).active).toBeNull();
  });
});
