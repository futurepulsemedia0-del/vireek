import { describe, it, expect, vi } from 'vitest';
import {
  buildGetRequest,
  buildQueryRequest,
  buildVoidRequest,
  buildWriteRequest,
  defaultSettings,
  mergeEntity,
  mergeFieldsFor,
  type RawRecord,
} from '../../supabase/functions/_shared/quickbooks/engine';
import {
  AuthError,
  RateLimitError,
  addRetry,
  conflictSig,
  faultText,
  isPaymentsBlock,
  qboRequest,
  writeWithStaleRetry,
  type ApiResult,
  type HttpDeps,
} from '../../supabase/functions/_shared/quickbooks/sync-core';
import runnerSource from '../../supabase/functions/qbo-sync-run/index.ts?raw';

const BASE = 'https://sandbox-quickbooks.api.intuit.com';
const URL_OK = `${BASE}/v3/company/123456789/customer?minorversion=75`;

const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

function deps(responses: Array<Response | Error>, over: Partial<HttpDeps> = {}) {
  const queue = [...responses];
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  let token = 'tok-1';
  const d: HttpDeps = {
    base: BASE,
    fetch: vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      const next = queue.shift();
      if (!next) throw new Error('unexpected extra fetch');
      if (next instanceof Error) throw next;
      return next;
    }),
    sleep: vi.fn(async () => undefined),
    getAccess: () => token,
    refresh: vi.fn(async () => {
      token = 'tok-2';
    }),
    ...over,
  };
  return { d, calls };
}

describe('conflictSig', () => {
  const fields = ['amounts', 'due_date'];
  const v = { amounts: '100|0|a~1~100', due_date: '2026-10-31', extra: 'x' };
  const q = { amounts: '120|0|a~1~120', due_date: '2026-10-31' };

  it('is deterministic and ignores keys outside the conflicting fields', () => {
    expect(conflictSig(fields, v, q)).toBe(conflictSig(fields, { ...v, extra: 'changed' }, q));
  });
  it('treats undefined and null the same (no re-logging of an unchanged conflict)', () => {
    expect(conflictSig(['x'], { x: undefined as unknown as null }, { x: null })).toBe(conflictSig(['x'], { x: null }, {}));
  });
  it('changes when either side value changes, or the field list changes', () => {
    const s = conflictSig(fields, v, q);
    expect(conflictSig(fields, { ...v, amounts: 'z' }, q)).not.toBe(s);
    expect(conflictSig(fields, v, { ...q, amounts: 'z' })).not.toBe(s);
    expect(conflictSig(['amounts'], v, q)).not.toBe(s);
  });
});

describe('retry list + payments block', () => {
  it('de-duplicates and keeps the newest entries within the cap', () => {
    expect(addRetry(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(addRetry(undefined, 'a')).toEqual(['a']);
    expect(addRetry(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
  it('recognises the SQL guard error', () => {
    expect(isPaymentsBlock('PAYMENTS_EXIST: invoice has payments')).toBe(true);
    expect(isPaymentsBlock('permission denied')).toBe(false);
  });
});

describe('qboRequest (rate limits, refresh, retries)', () => {
  it('returns parsed JSON and the intuit_tid', async () => {
    const { d } = deps([reply(200, { Customer: { Id: '1' } }, { intuit_tid: 'tid-9' })]);
    expect(await qboRequest(d, { method: 'GET', url: URL_OK })).toEqual({ status: 200, json: { Customer: { Id: '1' } }, tid: 'tid-9' });
  });

  it('429 throws RateLimitError immediately and never retries', async () => {
    const { d } = deps([reply(429, { Fault: {} })]);
    await expect(qboRequest(d, { method: 'GET', url: URL_OK })).rejects.toBeInstanceOf(RateLimitError);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('401 refreshes once, then retries with the NEW token', async () => {
    const { d, calls } = deps([reply(401), reply(200, { ok: true })]);
    const r = await qboRequest(d, { method: 'GET', url: URL_OK });
    expect(r.status).toBe(200);
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(calls[0].headers.Authorization).toBe('Bearer tok-1');
    expect(calls[1].headers.Authorization).toBe('Bearer tok-2');
  });

  it('a second 401 after refreshing throws AuthError (no refresh loop)', async () => {
    const { d } = deps([reply(401), reply(401)]);
    await expect(qboRequest(d, { method: 'GET', url: URL_OK })).rejects.toBeInstanceOf(AuthError);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx twice then returns the last response', async () => {
    const { d } = deps([reply(503), reply(503), reply(503, { Fault: { Error: [{ code: '1', Message: 'down' }] } })]);
    const r = await qboRequest(d, { method: 'GET', url: URL_OK });
    expect(r.status).toBe(503);
    expect(d.fetch).toHaveBeenCalledTimes(3);
    expect(d.sleep).toHaveBeenCalledTimes(2);
  });

  it('retries network errors twice, then rethrows', async () => {
    const boom = new Error('network down');
    const { d } = deps([boom, boom, boom]);
    await expect(qboRequest(d, { method: 'GET', url: URL_OK })).rejects.toBe(boom);
    expect(d.fetch).toHaveBeenCalledTimes(3);
  });

  it('handles 204 and non-JSON bodies without throwing', async () => {
    expect((await qboRequest(deps([reply(204)]).d, { method: 'GET', url: URL_OK })).json).toBeNull();
    expect((await qboRequest(deps([reply(200, '<html>oops</html>')]).d, { method: 'GET', url: URL_OK })).json).toBeNull();
  });

  it('refuses addresses outside QuickBooks before any network call', async () => {
    const { d } = deps([]);
    await expect(qboRequest(d, { method: 'GET', url: 'https://evil.example.com/v3/company/1/customer' })).rejects.toThrow(/outside QuickBooks/);
    await expect(qboRequest({ ...d, base: 'https://evil.example.com' }, { method: 'GET', url: 'https://evil.example.com/x' })).rejects.toThrow();
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('only sends Content-Type when there is a body', async () => {
    const { d, calls } = deps([reply(200, {}), reply(200, {})]);
    await qboRequest(d, { method: 'GET', url: URL_OK });
    await qboRequest(d, { method: 'POST', url: URL_OK, body: { a: 1 } });
    expect(calls[0].headers['Content-Type']).toBeUndefined();
    expect(calls[1].headers['Content-Type']).toBe('application/json');
    expect(calls[1].body).toBe('{"a":1}');
  });
});

describe('writeWithStaleRetry (SyncToken)', () => {
  const ok = (rec: RawRecord): ApiResult => ({ status: 200, json: { Customer: rec }, tid: 't1' });
  const fault = (code: string, status = 400): ApiResult => ({ status, json: { Fault: { Error: [{ code, Message: 'm', Detail: 'd' }] } }, tid: 't2' });

  it('succeeds first time', async () => {
    const send = vi.fn(async () => ok({ Id: '5', SyncToken: '1' }));
    const r = await writeWithStaleRetry({ send, fetchFresh: vi.fn() }, 'customer', { Id: '5', SyncToken: '0', sparse: true });
    expect(r).toMatchObject({ ok: true, record: { Id: '5' } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stale SyncToken (5010): refetches and retries ONCE with the fresh token', async () => {
    const send = vi.fn().mockResolvedValueOnce(fault('5010')).mockResolvedValueOnce(ok({ Id: '5', SyncToken: '8' }));
    const fetchFresh = vi.fn(async () => ({ Id: '5', SyncToken: '7' }) as RawRecord);
    const r = await writeWithStaleRetry({ send, fetchFresh }, 'customer', { Id: '5', SyncToken: '3', sparse: true, DisplayName: 'A' });
    expect(r.ok).toBe(true);
    expect(fetchFresh).toHaveBeenCalledWith('5');
    expect(send).toHaveBeenNthCalledWith(2, { Id: '5', SyncToken: '7', sparse: true, DisplayName: 'A' });
  });

  it('stale twice: gives up with kind "stale" (no endless loop)', async () => {
    const send = vi.fn(async () => fault('5010'));
    const fetchFresh = vi.fn(async () => ({ Id: '5', SyncToken: '7' }) as RawRecord);
    const r = await writeWithStaleRetry({ send, fetchFresh }, 'customer', { Id: '5', SyncToken: '3' });
    expect(r).toMatchObject({ ok: false, kind: 'stale' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it('stale but the record is gone: fails without a second write', async () => {
    const send = vi.fn(async () => fault('5010'));
    const r = await writeWithStaleRetry({ send, fetchFresh: async () => null }, 'customer', { Id: '5', SyncToken: '3' });
    expect(r).toMatchObject({ ok: false, kind: 'stale' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('creates (no Id) are never refetched or replayed', async () => {
    const send = vi.fn(async () => fault('5010'));
    const fetchFresh = vi.fn();
    const r = await writeWithStaleRetry({ send, fetchFresh }, 'payment', { TotalAmt: 10 });
    expect(r.ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchFresh).not.toHaveBeenCalled();
  });

  it('validation and duplicate faults are returned, not retried', async () => {
    for (const [code, kind] of [['2020', 'validation'], ['6240', 'duplicate']] as const) {
      const send = vi.fn(async () => fault(code));
      const r = await writeWithStaleRetry({ send, fetchFresh: vi.fn() }, 'customer', { Id: '1', SyncToken: '0' });
      expect(r).toMatchObject({ ok: false, kind, tid: 't2' });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('a 2xx without a record is an error, never a silent success', async () => {
    const r = await writeWithStaleRetry({ send: async () => ({ status: 200, json: {}, tid: null }), fetchFresh: vi.fn() }, 'customer', { DisplayName: 'x' });
    expect(r).toMatchObject({ ok: false, kind: 'error' });
  });

  it('faultText is capped and falls back to the HTTP status', () => {
    expect(faultText({ status: 502, json: null, tid: null })).toBe('HTTP 502');
    expect(faultText(fault('1')).length).toBeLessThanOrEqual(300);
  });
});

describe('invoice / payment merge rules', () => {
  const inv = defaultSettings().entities.invoice;
  const base = { due_date: '2026-10-31', amounts: '100|0|a~1~100', voided: 'active' };

  it('no change on either side: nothing moves, no conflict', () => {
    const r = mergeEntity({ entity: 'invoice', settings: inv, base, vireek: base, qbo: base, vireekTs: 1, qboTs: 2 });
    expect(r.toVireek).toEqual({});
    expect(r.toCrm).toEqual({});
    expect(r.conflicts).toEqual([]);
  });

  it('only one side changed the amounts: that side wins without a conflict', () => {
    const changed = { ...base, amounts: '200|0|a~1~200' };
    const a = mergeEntity({ entity: 'invoice', settings: inv, base, vireek: changed, qbo: base, vireekTs: 2, qboTs: 1 });
    expect(a.toCrm).toEqual({ amounts: changed.amounts });
    expect(a.conflicts).toEqual([]);
    const b = mergeEntity({ entity: 'invoice', settings: inv, base, vireek: base, qbo: changed, vireekTs: 1, qboTs: 2 });
    expect(b.toVireek).toEqual({ amounts: changed.amounts });
  });

  it('both sides changed the amounts: manual rule (the money default) = conflict, nothing written, base kept', () => {
    const r = mergeEntity({
      entity: 'invoice', settings: inv, base,
      vireek: { ...base, amounts: '200|0|a~1~200' }, qbo: { ...base, amounts: '300|0|a~1~300' }, vireekTs: 5, qboTs: 9,
    });
    expect(inv.conflict).toBe('manual');
    expect(r.conflicts.map((c) => c.field)).toEqual(['amounts']);
    expect(r.toVireek.amounts).toBeUndefined();
    expect(r.toCrm.amounts).toBeUndefined();
    expect(r.next.amounts).toBe(base.amounts);
  });

  it('void on one side + new amounts on the other merge per field; the payments guard lives downstream (SQL PAYMENTS_EXIST)', () => {
    const r = mergeEntity({
      entity: 'invoice', settings: inv, base,
      vireek: { ...base, voided: 'void' }, qbo: { ...base, amounts: '300|0|a~1~300' }, vireekTs: 5, qboTs: 9,
    });
    expect(r.toCrm).toEqual({ voided: 'void' });
    expect(r.toVireek).toEqual({ amounts: '300|0|a~1~300' });
    expect(r.conflicts).toEqual([]);
  });

  it('payments have no mergeable fields: they can only be created, never edited', () => {
    expect(mergeFieldsFor('payment', defaultSettings().entities.payment)).toEqual([]);
    const r = mergeEntity({ entity: 'payment', settings: defaultSettings().entities.payment, base: {}, vireek: { a: 1 }, qbo: { a: 2 }, vireekTs: 1, qboTs: 2 });
    expect(r).toMatchObject({ toVireek: {}, toCrm: {}, conflicts: [] });
  });
});

describe('deletes are never propagated', () => {
  it('no request builder can produce a DELETE', () => {
    const c = { base: BASE, realm: '123456789' };
    const reqs = [
      buildQueryRequest({ ...c, entity: 'invoice', since: null, pos: 1, pageSize: 10 }),
      buildGetRequest({ ...c, entity: 'invoice', id: '1' }),
      buildWriteRequest({ ...c, entity: 'invoice', payload: { Id: '1', SyncToken: '0', sparse: true } }),
      buildVoidRequest({ ...c, id: '1', syncToken: '0' }),
    ];
    for (const r of reqs) expect(['GET', 'POST']).toContain(r.method);
    expect(buildVoidRequest({ ...c, id: '1', syncToken: '0' }).url).toContain('operation=void');
  });

  it('the runner never issues HTTP DELETE and only deletes its own qbo_* bookkeeping rows', () => {
    expect(runnerSource).not.toMatch(/method:\s*["']DELETE["']/i);
    const tables = [...runnerSource.matchAll(/\.from\(["']([a-z_]+)["']\)\s*\.delete\(/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(t).toMatch(/^qbo_/);
  });

  it('the runner never updates or deletes ar_payments (payments are create-only)', () => {
    expect(runnerSource).not.toMatch(/\.from\(["']ar_payments["']\)\s*\.(update|delete|upsert)\(/);
  });

  it('shared helpers live in sync-core (no drifting copies in the runner)', () => {
    expect(runnerSource).not.toMatch(/function conflictSig\b/);
    expect(runnerSource).not.toMatch(/function addRetry\b/);
    expect(runnerSource).toMatch(/_shared\/quickbooks\/sync-core\.ts/);
  });
});
