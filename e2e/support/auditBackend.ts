// Mock telephony backend for the Missed-Call Audit e2e: the REAL service logic (handleAction) over the in-memory store
// and mock providers (no Twilio/Vapi/Resend/Turnstile), mounted on the browser via page.route.
import type { Page } from '@playwright/test';
import { GOOD_BUSINESS, LEAKY_BUSINESS } from '../../supabase/functions/_shared/audit/mock.ts';
import { makeWorld } from '../../supabase/functions/_shared/audit/testWorld.ts';

export function mountAuditBackend(page: Page, over: Parameters<typeof makeWorld>[0] = {}) {
  const world = makeWorld({ turnstileSiteKey: 'mock-site-key', ...over });
  const requests: { action: string; body: Record<string, unknown> }[] = [];
  const ready = page.route('**/functions/v1/audit-api', async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
    const { action, ...rest } = body;
    requests.push({ action: String(action), body: rest });
    const r = await world.act(String(action), rest, { ip: '203.0.113.9', userAgent: 'e2e', pageUrl: null });
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body), headers: { 'cache-control': 'no-store' } });
  });
  return { world, requests, ready, GOOD_BUSINESS, LEAKY_BUSINESS };
}
