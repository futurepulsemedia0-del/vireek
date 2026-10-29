import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
const inFilter = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: () => ({ select: () => ({ in: (...a: unknown[]) => inFilter(...a) }) }),
  },
}));

import {
  DM_MAX_CHARS,
  MESSENGER_WINDOW_MS,
  connectMessenger,
  connectTelegram,
  disconnectChannel,
  fetchDmConnections,
  isFacebookPageId,
  isPageAccessToken,
  isTelegramToken,
  mapConnectionRow,
  replyWindow,
  sendDmReply,
} from '@/lib/dmChannels';

beforeEach(() => {
  invoke.mockReset();
  inFilter.mockReset();
});

describe('replyWindow', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  it('is always open for Telegram and other channels', () => {
    expect(replyWindow('telegram', null, now).open).toBe(true);
    expect(replyWindow('whatsapp', undefined, now).open).toBe(true);
  });
  it('closes Messenger replies 24h after the last inbound message, or when unknown', () => {
    expect(replyWindow('messenger', new Date(now - MESSENGER_WINDOW_MS + 60_000).toISOString(), now).open).toBe(true);
    expect(replyWindow('messenger', new Date(now - MESSENGER_WINDOW_MS).toISOString(), now).open).toBe(false);
    expect(replyWindow('messenger', null, now).open).toBe(false);
    expect(replyWindow('messenger', 'garbage', now).open).toBe(false);
  });
});

describe('credential validators', () => {
  it('trims input and mirrors the server rules', () => {
    expect(isTelegramToken(' 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw ')).toBe(true);
    expect(isTelegramToken('nope')).toBe(false);
    expect(isFacebookPageId(' 104857341234567 ')).toBe(true);
    expect(isFacebookPageId('page-id')).toBe(false);
    expect(isPageAccessToken(`EAAB${'x'.repeat(30)}`)).toBe(true);
    expect(isPageAccessToken('has space inside the token value')).toBe(false);
  });
  it('exposes per-channel length limits', () => {
    expect(DM_MAX_CHARS).toEqual({ telegram: 4096, messenger: 2000 });
  });
});

describe('mapConnectionRow / fetchDmConnections', () => {
  it('maps snake_case rows and applies safe defaults', () => {
    expect(mapConnectionRow({ id: 'c1', channel: 'telegram', external_account_id: '99', display_name: '@acme_bot', status: 'connected' })).toEqual({
      id: 'c1', channel: 'telegram', externalAccountId: '99', displayName: '@acme_bot', status: 'connected', lastError: null,
    });
    expect(mapConnectionRow({ id: 'c2', channel: 'messenger', external_account_id: '5' }).status).toBe('disconnected');
  });
  it('returns mapped rows and throws the database error message', async () => {
    inFilter.mockResolvedValueOnce({ data: [{ id: 'c1', channel: 'messenger', external_account_id: '5', status: 'error', last_error: 'expired' }], error: null });
    expect(await fetchDmConnections()).toMatchObject([{ channel: 'messenger', status: 'error', lastError: 'expired' }]);
    inFilter.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(fetchDmConnections()).rejects.toThrow('permission denied');
  });
});

describe('edge function calls', () => {
  it('sends trimmed credentials to dm-connect', async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    expect(await connectTelegram(' tok ')).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith('dm-connect', { body: { action: 'connect', channel: 'telegram', botToken: 'tok' } });
    await connectMessenger(' 123 ', ' abc ');
    expect(invoke).toHaveBeenLastCalledWith('dm-connect', { body: { action: 'connect', channel: 'messenger', pageId: '123', pageToken: 'abc' } });
    await disconnectChannel('telegram');
    expect(invoke).toHaveBeenLastCalledWith('dm-connect', { body: { action: 'disconnect', channel: 'telegram' } });
  });
  it('surfaces the server message for handled failures and transport errors', async () => {
    invoke.mockResolvedValueOnce({ data: { ok: false, code: 'window_closed', message: 'Outside the 24-hour window.' }, error: null });
    expect(await sendDmReply('conv', 'hi')).toEqual({ ok: false, error: 'Outside the 24-hour window.' });
    invoke.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    expect(await sendDmReply('conv', 'hi')).toEqual({ ok: false, error: 'Failed to fetch' });
    invoke.mockResolvedValueOnce({ data: null, error: null });
    expect(await sendDmReply('conv', 'hi')).toEqual({ ok: false, error: 'Request failed' });
  });
});
