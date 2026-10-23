import { describe, expect, it } from 'vitest';
import {
  buildIdentityContext,
  ingestIdentity,
  lookupCallerIdentity,
  mergeCallerContext,
  parseIdentityLookup,
  type RpcClient,
} from '../../supabase/functions/_shared/identity-resolution';

const high = {
  matched: true,
  band: 'high',
  best: { customer_id: 'c1', name: 'John Smith', score: 97, conflict: false, signals: [{ type: 'phone' }, { type: 'email' }] },
  candidates: [{ customer_id: 'c1', name: 'John Smith', score: 97, conflict: false, signals: [{ type: 'phone' }, { type: 'email' }] }],
  household: { id: 'h1', name: 'Smith household', members: [{ customer_id: 'c2', name: 'Jane Smith', status: 'suggested' }] },
};

describe('parseIdentityLookup', () => {
  it('returns a safe empty result for garbage', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { band: 'none' }]) {
      const r = parseIdentityLookup(bad);
      expect(r.matched).toBe(false);
      expect(r.customerId).toBeNull();
    }
  });
  it('parses a high-confidence match with household', () => {
    const r = parseIdentityLookup(high);
    expect(r.band).toBe('high');
    expect(r.customerId).toBe('c1');
    expect(r.signals).toEqual(['phone', 'email']);
    expect(r.household?.members[0].name).toBe('Jane Smith');
  });
  it('keeps runner-ups as alternatives', () => {
    const r = parseIdentityLookup({ ...high, candidates: [...high.candidates, { customer_id: 'c7', name: 'Jon Smyth', score: 80 }] });
    expect(r.alternatives).toEqual([{ customerId: 'c7', name: 'Jon Smyth', score: 80 }]);
  });
});

describe('buildIdentityContext', () => {
  it('greets by name only at high confidence', () => {
    const text = buildIdentityContext(parseIdentityLookup(high));
    expect(text).toContain('John Smith');
    expect(text).toContain('You may greet them by name');
    expect(text).toContain('Jane Smith');
  });
  it('asks for confirmation at medium confidence and never leaks details', () => {
    const text = buildIdentityContext(parseIdentityLookup({ ...high, band: 'medium', household: null }));
    expect(text).toContain('Do NOT use the name');
    expect(text).not.toContain('You may greet');
  });
  it('treats a near-tie as medium even if the top band is high', () => {
    const text = buildIdentityContext(
      parseIdentityLookup({ ...high, candidates: [...high.candidates, { customer_id: 'c7', name: 'Other', score: 92 }] }),
    );
    expect(text).toContain('Do NOT use the name');
  });
  it('says nothing on conflict, low band or no match', () => {
    expect(buildIdentityContext(parseIdentityLookup({ ...high, best: { ...high.best, conflict: true } }))).toBe('');
    expect(buildIdentityContext(parseIdentityLookup({ ...high, band: 'low' }))).toBe('');
    expect(buildIdentityContext(parseIdentityLookup(null))).toBe('');
  });
});

describe('mergeCallerContext', () => {
  it('lets identity override the legacy "new caller" sentence', () => {
    const merged = mergeCallerContext('This is a new caller with no prior history on file — greet them normally.', 'Identity check: X');
    expect(merged).toBe('Identity check: X');
  });
  it('appends identity to a returning-caller context', () => {
    expect(mergeCallerContext('Returning caller named John.', 'Identity check: X')).toBe('Returning caller named John. Identity check: X');
  });
  it('is a no-op without identity', () => {
    expect(mergeCallerContext('base', '')).toBe('base');
  });
});

function client(result: { data: unknown; error: { message: string } | null } | Error): RpcClient & { calls: { fn: string; args?: Record<string, unknown> }[] } {
  const calls: { fn: string; args?: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      if (result instanceof Error) throw result;
      return Promise.resolve(result);
    },
  };
}

describe('lookupCallerIdentity / ingestIdentity', () => {
  it('passes normalised params to the RPC', async () => {
    const c = client({ data: high, error: null });
    const r = await lookupCallerIdentity(c, 'owner', { phone: '+15125550123', name: 'John' });
    expect(r.customerId).toBe('c1');
    expect(c.calls[0].fn).toBe('identity_lookup');
    expect(c.calls[0].args).toMatchObject({ p_owner: 'owner', p_phone: '+15125550123', p_email: null, p_name: 'John', p_limit: 3 });
  });
  it('never throws: RPC error, thrown exception', async () => {
    expect((await lookupCallerIdentity(client({ data: null, error: { message: 'x' } }), 'o', { phone: '1' })).matched).toBe(false);
    expect((await lookupCallerIdentity(client(new Error('network')), 'o', { phone: '1' })).matched).toBe(false);
    expect(await ingestIdentity(client(new Error('network')), 'o', { phone: '1' }, 'call')).toBeNull();
    expect(await ingestIdentity(client({ data: null, error: { message: 'x' } }), 'o', {}, 'call')).toBeNull();
  });
  it('parses the ingest result', async () => {
    const r = await ingestIdentity(client({ data: { status: 'linked', customer_id: 'c1' }, error: null }), 'o', { phone: '1' }, 'call', 'call-1');
    expect(r).toEqual({ status: 'linked', customerId: 'c1' });
  });
});
