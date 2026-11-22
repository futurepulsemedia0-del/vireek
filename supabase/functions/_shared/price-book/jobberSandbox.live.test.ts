// Sandbox contract suite for Jobber. Runs ONLY with `npx vitest run -c vitest.live.config.ts` AND JOBBER_SANDBOX_TOKEN set
// (an access token of a Jobber *developer test account*, never a customer account). It performs READ-ONLY queries.
// Purpose: prove the response shapes our fixtures and parsers assume, and that throttling metadata is present.
// STATUS: NOT RUN (no Jobber test account was available when this was written). Shapes below are [VERIFY].
import { describe, expect, it } from 'vitest';
import { fetchJobberAccountId } from './jobberAccount';
import { fetchJobberProducts, JOBBER_API_VERSION, JOBBER_GRAPHQL_URL } from './jobber';

const TOKEN = process.env.JOBBER_SANDBOX_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('Jobber sandbox (read-only)', () => {
  it('account { id } returns a non-empty id (used to route APP_DISCONNECT webhooks)', async () => {
    const id = await fetchJobberAccountId(TOKEN!);
    expect(typeof id).toBe('string');
    expect(id!.length).toBeGreaterThan(0);
  });

  it('products query paginates and normalises without throwing', async () => {
    const items = await fetchJobberProducts(TOKEN!);
    expect(Array.isArray(items)).toBe(true);
    for (const i of items.slice(0, 20)) {
      expect(typeof i.external_id).toBe('string');
      expect(Number.isInteger(i.price_cents)).toBe(true);
    }
  });

  it('every response carries extensions.cost.throttleStatus (the data backoff relies on)', async () => {
    const res = await fetch(JOBBER_GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION },
      body: JSON.stringify({ query: '{ account { id } }' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } } };
    expect(typeof body.extensions?.cost?.throttleStatus?.currentlyAvailable).toBe('number');
    expect(typeof body.extensions?.cost?.throttleStatus?.restoreRate).toBe('number');
  });
});
