// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blocksSending, buildVerificationBody, classifyDeliverability, parseVerificationResponse, verifyAddressWithLob,
} from '../../supabase/functions/_shared/direct-mail/verify';

// ---- supabase mock: a thenable query chain over in-memory tables ----------------------------------------------------
type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const rpcCalls: { name: string; args: unknown }[] = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => { rpcCalls.push({ name, args }); return Promise.resolve(rpcResult); },
    functions: { invoke: vi.fn() },
    from: (table: string) => {
      let columns = '';
      let ids: string[] | null = null;
      const chain: Record<string, unknown> = {
        select: (c: string) => { columns = c; return chain; },
        eq: () => chain, or: () => chain, overlaps: () => chain, not: () => chain, order: () => chain, limit: () => chain, range: () => chain,
        in: (_col: string, v: string[]) => { ids = v; return chain; },
        then: (resolve: (v: unknown) => unknown) => {
          let rows = tables[table] ?? [];
          if (ids && table === 'customers') rows = rows.filter((r) => ids!.includes(String(r.id)));
          if (table === 'customers' && columns.includes('address') && !columns.includes('lifecycle_stage')) {
            rows = rows.map((r) => ({ name: r.name, address: r.address }));
          }
          return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve);
        },
      };
      return chain;
    },
  },
}));

import {
  MAX_CAMPAIGN_RECIPIENTS, fetchVerificationSummary, linkSegment, listSegments, resolveSegmentRecipients, verificationLabel,
  verifyUntilDone, type VerifyResult,
} from './directMailAudience';

beforeEach(() => { tables = {}; rpcCalls.length = 0; rpcResult = { data: null, error: null }; });

// ---- classification -------------------------------------------------------------------------------------------------
describe('classifyDeliverability', () => {
  it('maps every documented value', () => {
    expect(classifyDeliverability('deliverable')).toEqual({ status: 'deliverable', note: null });
    expect(classifyDeliverability('deliverable_unnecessary_unit').status).toBe('deliverable');
    expect(classifyDeliverability('deliverable_incorrect_unit').status).toBe('review');
    expect(classifyDeliverability('deliverable_missing_unit').status).toBe('review');
    expect(classifyDeliverability('undeliverable').status).toBe('undeliverable');
  });
  it('never treats unknown values as deliverable and is case/space tolerant', () => {
    expect(classifyDeliverability('mystery').status).toBe('review');
    expect(classifyDeliverability(undefined).status).toBe('review');
    expect(classifyDeliverability(42).status).toBe('review');
    expect(classifyDeliverability('  DELIVERABLE ').status).toBe('deliverable');
  });
  it('only live mode removes recipients', () => {
    expect(blocksSending('live')).toBe(true);
    expect(blocksSending('test')).toBe(false);
    expect(blocksSending(null)).toBe(false);
  });
});

describe('request / response shape', () => {
  it('builds a trimmed body and omits an empty secondary line', () => {
    expect(buildVerificationBody({ line1: ' 1 Main St ', line2: '  ', city: ' Austin ', state: 'tx', zip: ' 78701 ' })).toEqual({
      primary_line: '1 Main St', city: 'Austin', state: 'TX', zip_code: '78701',
    });
    expect(buildVerificationBody({ line1: '1 Main St', line2: 'Apt 4', city: 'Austin', state: 'TX', zip: '78701' }).secondary_line).toBe('Apt 4');
  });
  it('rejects unusable responses', () => {
    expect(parseVerificationResponse(null)).toBeNull();
    expect(parseVerificationResponse('x')).toBeNull();
    expect(parseVerificationResponse({})).toBeNull();
    expect(parseVerificationResponse({ deliverability: '' })).toBeNull();
    expect(parseVerificationResponse({ deliverability: 'deliverable' })?.status).toBe('deliverable');
  });
});

// ---- mocked Lob -----------------------------------------------------------------------------------------------------
const address = { line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', zip: '78701' };
const reply = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

describe('verifyAddressWithLob (mocked Lob, not live-verified)', () => {
  it('calls the documented endpoint with basic auth and returns the classified outcome', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ deliverability: 'deliverable_missing_unit' }), { status: 200 })));
    const r = await verifyAddressWithLob({ fetchImpl: fetchImpl as unknown as typeof fetch, apiKey: 'test_abc', address, version: '2024-01-01' });
    expect(r).toEqual({ kind: 'ok', outcome: { status: 'review', note: 'USPS expects a unit or apartment number.' } });
    const [url, init] = (fetchImpl.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe('https://api.lob.com/v1/us_verifications');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('test_abc:')}`);
    expect(headers['Lob-Version']).toBe('2024-01-01');
    expect(JSON.parse(init.body as string)).toEqual({ primary_line: '1 Main St', city: 'Austin', state: 'TX', zip_code: '78701' });
  });
  it('flags an undeliverable address', async () => {
    const r = await verifyAddressWithLob({ fetchImpl: reply(200, { deliverability: 'undeliverable' }), apiKey: 'live_x', address });
    expect(r.kind === 'ok' && r.outcome.status).toBe('undeliverable');
  });
  it('reports a rejected key', async () => {
    expect(await verifyAddressWithLob({ fetchImpl: reply(401, {}), apiKey: 'k', address })).toEqual({ kind: 'auth' });
    expect(await verifyAddressWithLob({ fetchImpl: reply(403, {}), apiKey: 'k', address })).toEqual({ kind: 'auth' });
  });
  it('turns Lob input rejections (422) into a review, not an endless retry', async () => {
    const r = await verifyAddressWithLob({ fetchImpl: reply(422, { error: { message: 'primary_line is required' } }), apiKey: 'k', address });
    expect(r).toEqual({ kind: 'ok', outcome: { status: 'review', note: 'primary_line is required' } });
  });
  it('retries throttling, server errors, timeouts and unreadable answers', async () => {
    for (const status of [408, 409, 425, 429, 500, 503]) {
      expect((await verifyAddressWithLob({ fetchImpl: reply(status, {}), apiKey: 'k', address })).kind).toBe('retry');
    }
    expect((await verifyAddressWithLob({ fetchImpl: reply(200, { nothing: true }), apiKey: 'k', address })).kind).toBe('retry');
    const boom = (() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch;
    expect(await verifyAddressWithLob({ fetchImpl: boom, apiKey: 'k', address })).toEqual({ kind: 'retry', message: 'socket hang up' });
  });
  it('treats other 4xx as a hard failure with the provider message', async () => {
    expect(await verifyAddressWithLob({ fetchImpl: reply(400, { error: { message: 'bad request' } }), apiKey: 'k', address })).toEqual({ kind: 'failed', message: 'bad request' });
  });
});

// ---- resumable loop -------------------------------------------------------------------------------------------------
const round = (p: Partial<VerifyResult>): VerifyResult => ({ processed: 0, deliverable: 0, review: 0, undeliverable: 0, errors: 0, remaining: 0, blocking: true, ...p });

describe('verifyUntilDone', () => {
  it('keeps calling until nothing remains and sums the rounds', async () => {
    const queue = [round({ processed: 10, deliverable: 8, review: 1, undeliverable: 1, remaining: 5 }), round({ processed: 5, deliverable: 5, remaining: 0 })];
    const progress: number[] = [];
    const { total, stalled } = await verifyUntilDone(() => Promise.resolve(queue.shift()!), (t) => progress.push(t.processed));
    expect(stalled).toBe(false);
    expect(total).toMatchObject({ processed: 15, deliverable: 13, review: 1, undeliverable: 1, remaining: 0 });
    expect(progress).toEqual([10, 15]);
  });
  it('stops (stalled) when a round decides nothing, instead of hammering the provider', async () => {
    const run = vi.fn(() => Promise.resolve(round({ processed: 10, errors: 10, remaining: 40 })));
    const { stalled, total } = await verifyUntilDone(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(stalled).toBe(true);
    expect(total.remaining).toBe(40);
  });
  it('honours the stop signal (user left the page)', async () => {
    const run = vi.fn(() => Promise.resolve(round({ deliverable: 1, remaining: 9 })));
    await verifyUntilDone(run, undefined, () => true);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('verificationLabel', () => {
  it('only labels queued mailers', () => {
    expect(verificationLabel({ status: 'queued', verification_status: 'deliverable' })).toEqual({ text: 'Address verified', tone: 'ok' });
    expect(verificationLabel({ status: 'queued', verification_status: 'review', verification_note: 'Missing unit' })?.text).toBe('Check address: Missing unit');
    expect(verificationLabel({ status: 'queued', verification_status: 'undeliverable' })?.tone).toBe('bad');
    expect(verificationLabel({ status: 'queued', verification_status: 'unverified' })).toBeNull();
    expect(verificationLabel({ status: 'failed', verification_status: 'undeliverable' })).toBeNull();
    expect(verificationLabel({ status: 'queued' })).toBeNull();
  });
});

// ---- segments -------------------------------------------------------------------------------------------------------
describe('segments', () => {
  it('lists segments and marks lead audiences as not mailable', async () => {
    tables.marketing_segments = [
      { id: 's1', name: 'VIP', filter: { entity: 'customer', lifecycle_stage: ['vip'] } },
      { id: 's2', name: 'New leads', filter: { entity: 'lead', stage: ['new'] } },
      { id: 's3', name: 'Legacy', filter: null },
    ];
    const list = await listSegments('owner-1');
    expect(list.map((s) => [s.id, s.entity, s.mailable])).toEqual([['s1', 'customer', true], ['s2', 'lead', false], ['s3', 'customer', true]]);
    expect(list[0].filter).toEqual({ entity: 'customer', lifecycle_stage: ['vip'] });
  });

  it('resolves a customer segment into mailable, de-duplicated addresses', async () => {
    tables.customers = [
      { id: 'c1', name: 'Ann', address: '1 Main St, Austin, TX 78701' },
      { id: 'c2', name: 'Ann (dup)', address: '1 MAIN ST, Austin, TX 78701' },
      { id: 'c3', name: 'Bob', address: null },
      { id: 'c4', name: 'Cy', address: 'somewhere vague' },
      { id: 'c5', name: 'Di', address: '9 Oak Ave, Dallas, TX 75201' },
    ];
    const r = await resolveSegmentRecipients('owner-1', { entity: 'customer' });
    expect(r.matched).toBe(5);
    expect(r.noAddress).toBe(1);
    expect(r.recipients.map((x) => x.name)).toEqual(['Ann', 'Di']);
    expect(r.duplicates).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it('never resolves lead audiences (no address on leads)', async () => {
    tables.leads = [{ id: 'l1', name: 'Lee' }];
    expect(await resolveSegmentRecipients('owner-1', { entity: 'lead' })).toMatchObject({ recipients: [], matched: 0 });
  });

  it('reads customer addresses in id chunks of 150', async () => {
    tables.customers = Array.from({ length: 320 }, (_, i) => ({ id: `c${i}`, name: `N${i}`, address: `${i + 1} Main St, Austin, TX 78701` }));
    const r = await resolveSegmentRecipients('owner-1', { entity: 'customer' });
    expect(r.matched).toBe(320);
    expect(r.recipients).toHaveLength(320);
    expect(MAX_CAMPAIGN_RECIPIENTS).toBe(20000);
  });
});

describe('RPC wrappers', () => {
  it('links the segment through the manager-only RPC', async () => {
    await linkSegment('camp-1', 'seg-1');
    expect(rpcCalls).toEqual([{ name: 'direct_mail_link_audience', args: { p_campaign_id: 'camp-1', p_segment_id: 'seg-1' } }]);
  });
  it('surfaces a friendly message when the campaign is locked', async () => {
    rpcResult = { data: null, error: { message: 'campaign_locked' } };
    await expect(linkSegment('camp-1', 'seg-1')).rejects.toThrow(/already been sent/i);
  });
  it('coerces the verification summary', async () => {
    rpcResult = { data: { queued: '12', unverified: 3, deliverable: 7, review: 1, undeliverable: 1 }, error: null };
    expect(await fetchVerificationSummary('camp-1')).toEqual({ queued: 12, unverified: 3, deliverable: 7, review: 1, undeliverable: 1 });
    rpcResult = { data: null, error: null };
    expect(await fetchVerificationSummary('camp-1')).toEqual({ queued: 0, unverified: 0, deliverable: 0, review: 0, undeliverable: 0 });
  });
});
