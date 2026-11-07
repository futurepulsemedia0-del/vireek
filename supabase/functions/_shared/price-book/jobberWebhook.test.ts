import { describe, expect, it } from 'vitest';
import { jobberEventKey, parseJobberWebhook } from './jobberWebhook';

const ok = '{"data":{"webHookEvent":{"topic":"APP_DISCONNECT","appId":"app","accountId":"MQ==","itemId":"MQ==","occurredAt":"2026-11-03T10:00:00Z"}}}';

describe('parseJobberWebhook', () => {
  it('parses the documented payload', () => {
    expect(parseJobberWebhook(ok)).toEqual({ topic: 'APP_DISCONNECT', appId: 'app', accountId: 'MQ==', itemId: 'MQ==', occurredAt: '2026-11-03T10:00:00Z' });
  });
  it('accepts the legacy misspelt occuredAt', () => {
    const e = parseJobberWebhook(ok.replace('occurredAt', 'occuredAt'));
    expect(e?.occurredAt).toBe('2026-11-03T10:00:00Z');
  });
  it('rejects malformed, empty and incomplete payloads', () => {
    for (const raw of ['', 'not json', '{}', '{"data":{}}', '{"data":{"webHookEvent":{"topic":"X"}}}', 'null', 'a=1&b=2']) {
      expect(parseJobberWebhook(raw)).toBeNull();
    }
  });
});

describe('jobberEventKey', () => {
  it('is deterministic and sensitive to every identifying field', async () => {
    const e = parseJobberWebhook(ok)!;
    expect(await jobberEventKey(e)).toBe(await jobberEventKey({ ...e }));
    for (const patch of [{ topic: 'APP_CONNECT' }, { accountId: 'Mg==' }, { itemId: 'Mg==' }, { occurredAt: 'x' }, { appId: 'b' }]) {
      expect(await jobberEventKey({ ...e, ...patch })).not.toBe(await jobberEventKey(e));
    }
    expect(await jobberEventKey(e)).toMatch(/^[0-9a-f]{64}$/);
  });
});
