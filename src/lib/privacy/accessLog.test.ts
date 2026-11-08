import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: vi.fn() } }));

import { AccessLogError, classifyAccessError, parseAccessHistory, parseAlerts, parseStaffTrail, readCallSensitive } from './accessLog';

beforeEach(() => {
  rpc.mockReset();
});

describe('parsers drop malformed rows instead of trusting the server shape', () => {
  it('parseAccessHistory keeps valid rows only', () => {
    const rows = parseAccessHistory([
      { occurred_at: '2026-11-01T10:00:00Z', viewer_kind: 'user', viewer_email: 'a@b.test', asset_class: 'transcript', action: 'view', channel: 'rpc', record_count: 1, is_you: true },
      { occurred_at: '2026-11-01T10:00:00Z', viewer_kind: 'alien', asset_class: 'transcript' },
      { occurred_at: '2026-11-01T10:00:00Z', viewer_kind: 'user', asset_class: 'secrets' },
      null, 'x',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ viewerKind: 'user', isYou: true, recordCount: 1 });
    expect(parseAccessHistory('nope')).toEqual([]);
  });
  it('parseAlerts rejects unknown rules; parseStaffTrail needs time + event', () => {
    expect(parseAlerts([{ id: 'x', rule: 'made_up', severity: 'high', status: 'open' }])).toEqual([]);
    expect(parseAlerts([{ id: 'x', rule: 'bulk_scraping', severity: 'high', status: 'open', observed: 250, threshold: 200 }])).toHaveLength(1);
    expect(parseStaffTrail([{ occurred_at: 't', event: 'impersonation_start' }, { event: 'only' }])).toHaveLength(1);
  });
});

describe('error mapping', () => {
  it('maps database codes to typed kinds', () => {
    expect(classifyAccessError({ code: 'SR429' }).kind).toBe('rate_limited');
    expect(classifyAccessError({ code: 'SR401' }).kind).toBe('step_up_required');
    expect(classifyAccessError({ code: '42501' }).kind).toBe('forbidden');
    expect(classifyAccessError({ code: '28000' }).kind).toBe('unauthenticated');
    expect(classifyAccessError({ code: 'XX' }).kind).toBe('unknown');
    expect(classifyAccessError(null)).toBeInstanceOf(AccessLogError);
  });
});

describe('readCallSensitive (protected, logged read)', () => {
  it('returns recording + transcript from the RPC', async () => {
    rpc.mockResolvedValue({ data: [{ recording_url: 'https://r/1.mp3', transcript: 'hi' }], error: null });
    await expect(readCallSensitive('id-1')).resolves.toEqual({ recordingUrl: 'https://r/1.mp3', transcript: 'hi' });
    expect(rpc).toHaveBeenCalledWith('read_call_sensitive', { p_call_id: 'id-1' });
  });
  it('returns null for other tenant / missing call (empty set)', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(readCallSensitive('id-2')).resolves.toBeNull();
  });
  it('throws a typed error on denial or rate limit so the page fails closed', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'SR429', message: 'x' } });
    await expect(readCallSensitive('id-3')).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
