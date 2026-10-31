import { describe, it, expect, vi } from 'vitest';
import { handleDetect, safeEqual, type RpcClient } from './detect-handler';

const SECRET = 'test-secret-123';
const OWNER = '11111111-1111-4111-8111-111111111111';

function client(result: { data?: unknown; error?: { message: string } | null } = { data: { ok: true, created: 2 }, error: null }) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  return { rpc, admin: { rpc } as unknown as RpcClient };
}
const req = (method: string, headers: Record<string, string> = {}, body?: string) =>
  new Request('https://example.test/detect-warranty-claims', { method, headers, body });

describe('detect-warranty-claims handler', () => {
  it('rejects a missing or wrong secret and never touches the database', async () => {
    const { rpc, admin } = client();
    expect((await handleDetect(req('POST'), { secret: SECRET, admin })).status).toBe(401);
    expect((await handleDetect(req('POST', { 'x-warranty-secret': 'nope' }), { secret: SECRET, admin })).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails closed when the server secret is not configured', async () => {
    const { rpc, admin } = client();
    const res = await handleDetect(req('POST', { 'x-warranty-secret': '' }), { secret: '', admin });
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers CORS preflight and rejects non-POST', async () => {
    const { admin } = client();
    expect((await handleDetect(req('OPTIONS'), { secret: SECRET, admin })).status).toBe(200);
    expect((await handleDetect(req('GET', { 'x-warranty-secret': SECRET }), { secret: SECRET, admin })).status).toBe(405);
  });

  it('runs the detector with safe defaults on an empty body', async () => {
    const { rpc, admin } = client();
    const res = await handleDetect(req('POST', { 'x-warranty-secret': SECRET }), { secret: SECRET, admin });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('warranty_recovery_detect', { p_owner: null, p_lookback_days: 180, p_limit: 500 });
    expect(await res.json()).toEqual({ ok: true, result: { ok: true, created: 2 } });
  });

  it('passes a valid owner scope and clamps out-of-range numbers back to defaults', async () => {
    const { rpc, admin } = client();
    await handleDetect(
      req('POST', { 'x-warranty-secret': SECRET }, JSON.stringify({ owner_id: OWNER, lookback_days: 99999, limit: -1 })),
      { secret: SECRET, admin },
    );
    expect(rpc).toHaveBeenCalledWith('warranty_recovery_detect', { p_owner: OWNER, p_lookback_days: 180, p_limit: 500 });
  });

  it('rejects malformed JSON and a non-UUID owner_id', async () => {
    const { rpc, admin } = client();
    expect((await handleDetect(req('POST', { 'x-warranty-secret': SECRET }, '{not json'), { secret: SECRET, admin })).status).toBe(400);
    expect((await handleDetect(req('POST', { 'x-warranty-secret': SECRET }, JSON.stringify({ owner_id: "x'; drop table" })), { secret: SECRET, admin })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns a generic 500 and does not echo database error text', async () => {
    const { admin } = client({ error: { message: 'relation "secret_table" does not exist' } });
    const log = vi.fn();
    const res = await handleDetect(req('POST', { 'x-warranty-secret': SECRET }), { secret: SECRET, admin, log });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret_table');
    expect(log).toHaveBeenCalled();
  });

  it('safeEqual is length- and content-sensitive', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
