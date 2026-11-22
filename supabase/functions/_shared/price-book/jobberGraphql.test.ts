// Contract tests for the Jobber GraphQL client used on the booking path, driven by recorded-shape fixtures in __fixtures__/.
// Fixtures are hand-authored from documented shapes until replaced by real sandbox recordings (see __fixtures__/README.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobberGraphQL } from './jobberGraphql';

const fx = (name: string): string => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const json = (raw: string, status = 200, headers: Record<string, string> = {}) => new Response(raw, { status, headers });

function harness(responses: Array<Response | Error>) {
  const sleeps: number[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  return {
    sleeps, requests, calls: () => i,
    deps: {
      fetchImpl: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), init });
        const r = responses[i++];
        if (r instanceof Error) throw r;
        return r;
      }) as typeof fetch,
      sleep: async (ms: number) => void sleeps.push(ms),
      now: () => 1_000_000,
      random: () => 0.5,
    },
  };
}
const MUTATION = 'mutation M($input: ClientCreateInput!) { clientCreate(input: $input) { client { id } userErrors { message } } }';

describe('jobberGraphQL', () => {
  it('sends bearer token, pinned API version header and the variables', async () => {
    const h = harness([json(fx('jobber-client-create.json'))]);
    const data = await jobberGraphQL('tok', MUTATION, { input: { firstName: 'Ann' } }, {}, h.deps);
    const headers = h.requests[0].init.headers as Record<string, string>;
    expect(h.requests[0].url).toBe('https://api.getjobber.com/api/graphql');
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['X-JOBBER-GRAPHQL-VERSION']).toBe('2025-04-16');
    expect(JSON.parse(String(h.requests[0].init.body)).variables).toEqual({ input: { firstName: 'Ann' } });
    expect(data?.clientCreate.client.id).toBe('Z2lkOi8vSm9iYmVyL0NsaWVudC80NTY=');
  });

  it('THROTTLED on a mutation: waits for the reported budget refill, retries once, succeeds', async () => {
    const h = harness([json(fx('jobber-throttled.json')), json(fx('jobber-client-create.json'))]);
    const data = await jobberGraphQL('tok', MUTATION, {}, {}, h.deps);
    expect(h.calls()).toBe(2);
    expect(h.sleeps).toEqual([500]); // (500 needed - 0 available) / 1000 per second, from the fixture's cost block
    expect(data?.clientCreate.client.id).toBeTruthy();
  });

  it('HTTP 429 honours Retry-After, also for mutations (the server declined the request)', async () => {
    const h = harness([json('{}', 429, { 'Retry-After': '2' }), json(fx('jobber-request-create.json'))]);
    const data = await jobberGraphQL('tok', 'mutation { x }', {}, {}, h.deps);
    expect(h.sleeps).toEqual([2000]);
    expect(data?.requestCreate.request.id).toBeTruthy();
  });

  it('gives up with graphql_throttled when the budget never recovers (no endless loop)', async () => {
    const h = harness([json(fx('jobber-throttled.json')), json(fx('jobber-throttled.json')), json(fx('jobber-throttled.json'))]);
    await expect(jobberGraphQL('tok', MUTATION, {}, {}, h.deps)).rejects.toThrow('graphql_throttled');
    expect(h.calls()).toBe(3);
  });

  it('never retries a mutation after HTTP 500 (it may already have been applied), but does retry a read', async () => {
    const w = harness([json('{}', 500), json(fx('jobber-client-create.json'))]);
    await expect(jobberGraphQL('tok', MUTATION, {}, {}, w.deps)).rejects.toThrow('graphql_http_500');
    expect(w.calls()).toBe(1);
    const r = harness([json('{}', 500), json(fx('jobber-client-search.json'))]);
    const data = await jobberGraphQL('tok', 'query { clients { nodes { id } } }', {}, { idempotent: true }, r.deps);
    expect(r.calls()).toBe(2);
    expect(data?.clients.nodes[0].id).toBe('Z2lkOi8vSm9iYmVyL0NsaWVudC8xMjM=');
  });

  it('does not retry auth failures (401)', async () => {
    const h = harness([json('{}', 401)]);
    await expect(jobberGraphQL('bad', 'query { x }', {}, { idempotent: true }, h.deps)).rejects.toThrow('graphql_http_401');
    expect(h.calls()).toBe(1);
  });

  it('returns the data of an empty search and surfaces non-throttle GraphQL errors as jobber_graphql_error_*', async () => {
    const empty = await jobberGraphQL('tok', 'query { x }', {}, {}, harness([json(fx('jobber-client-search-empty.json'))]).deps);
    expect(empty?.clients.nodes).toEqual([]);
    const bad = harness([json('{"errors":[{"message":"Field does not exist"}]}')]);
    await expect(jobberGraphQL('tok', 'query { x }', {}, {}, bad.deps)).rejects.toThrow('jobber_graphql_error_Field does not exist');
    expect(bad.calls()).toBe(1);
  });

  it('keeps userErrors for the caller to inspect (the client does not swallow or throw on them)', async () => {
    const data = await jobberGraphQL('tok', 'mutation { x }', {}, {}, harness([json(fx('jobber-request-create-usererror.json'))]).deps);
    expect(data?.requestCreate.request).toBeNull();
    expect(data?.requestCreate.userErrors[0].message).toBe('Client is archived');
  });
});
