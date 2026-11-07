import { describe, expect, it } from 'vitest';
import { fetchJobberAccountId } from './jobberAccount';

const deps = (body: unknown, status = 200) => ({
  fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
  sleep: async () => undefined,
});

describe('fetchJobberAccountId', () => {
  it('returns the account id', async () => {
    expect(await fetchJobberAccountId('t', deps({ data: { account: { id: 'Q2xpZW50' } } }))).toBe('Q2xpZW50');
  });
  it('returns null on missing id, GraphQL errors or HTTP failure (never throws)', async () => {
    expect(await fetchJobberAccountId('t', deps({ data: { account: {} } }))).toBeNull();
    expect(await fetchJobberAccountId('t', deps({ errors: [{ message: 'x' }] }))).toBeNull();
    expect(await fetchJobberAccountId('t', deps({}, 401))).toBeNull();
  });
});
