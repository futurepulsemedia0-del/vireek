import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  const state: { insert: { data: unknown; error: { code?: string; message?: string } | null }; existing: unknown; upload: { error: unknown }; signed: { data: unknown; error: unknown } } = {
    insert: { data: null, error: null },
    existing: null,
    upload: { error: null },
    signed: { data: [], error: null },
  };
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'or', 'gt', 'update']) c[m] = vi.fn(() => c);
    c.single = vi.fn(async () => state.insert);
    c.maybeSingle = vi.fn(async () => ({ data: state.existing, error: null }));
    return c;
  };
  return { calls, state, chain };
});

vi.mock('@/lib/supabase', () => {
  const from = vi.fn((table: string) => {
    const c = h.chain();
    c.insert = vi.fn((row: unknown) => {
      (h.calls[table] ??= []).push(row);
      return c;
    });
    return c;
  });
  const storageFrom = vi.fn(() => ({
    upload: vi.fn(async (path: string) => {
      (h.calls.upload ??= []).push(path);
      return h.state.upload;
    }),
    remove: vi.fn(async (p: string[]) => {
      (h.calls.remove ??= []).push(p);
      return { error: null };
    }),
    createSignedUrls: vi.fn(async (paths: string[]) => {
      (h.calls.sign ??= []).push(paths);
      return h.state.signed;
    }),
  }));
  return { supabase: { from, storage: { from: storageFrom }, rpc: vi.fn() } };
});

import { ChatError, clearSignedUrlCache, friendlyError, getSignedUrls, sendMedia, sendText } from '@/lib/teamChatApi';

const row = { id: 'srv', channel_id: 'c1', sender_id: 'u1', kind: 'text', body: 'hi', client_id: 'cid' };

beforeEach(() => {
  for (const k of Object.keys(h.calls)) delete h.calls[k];
  h.state.insert = { data: row, error: null };
  h.state.existing = null;
  h.state.upload = { error: null };
  h.state.signed = { data: [], error: null };
  clearSignedUrlCache();
});

describe('friendlyError', () => {
  it('maps RLS, rate limit and edit window to safe copy', () => {
    expect(friendlyError({ code: '42501' }).code).toBe('forbidden');
    expect(friendlyError({ code: 'P0001', message: 'rate_limited' }).code).toBe('rate_limited');
    expect(friendlyError({ message: 'edit_window_closed' }).code).toBe('edit_window');
    expect(friendlyError({ message: 'boom: secret detail' }).message).not.toMatch(/secret/);
  });
});

describe('sendText', () => {
  it('trims, sends with the client id and returns the stored row', async () => {
    const saved = await sendText({ channelId: 'c1', text: '  hi  ', clientId: 'cid' });
    expect(saved.id).toBe('srv');
    expect(h.calls.chat_messages[0]).toMatchObject({ channel_id: 'c1', kind: 'text', body: 'hi', client_id: 'cid' });
  });
  it('rejects blank text before any network call', async () => {
    await expect(sendText({ channelId: 'c1', text: '  ' })).rejects.toBeInstanceOf(ChatError);
    expect(h.calls.chat_messages).toBeUndefined();
  });
  it('treats a duplicate client_id as success (idempotent retry)', async () => {
    h.state.insert = { data: null, error: { code: '23505' } };
    h.state.existing = row;
    await expect(sendText({ channelId: 'c1', text: 'hi', clientId: 'cid', senderId: 'u1' })).resolves.toMatchObject({ id: 'srv' });
  });
  it('surfaces other failures with friendly copy', async () => {
    h.state.insert = { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
    await expect(sendText({ channelId: 'c1', text: 'hi' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('sendMedia', () => {
  const channel = { id: 'c1', user_id: 'acct' };
  it('uploads to <account>/<channel>/<sender>_<id>.<ext> then inserts the message', async () => {
    h.state.insert = { data: { ...row, kind: 'image' }, error: null };
    await sendMedia({ channel, senderId: 'u1', kind: 'image', blob: new Blob(['x'], { type: 'image/jpeg' }), mime: 'image/jpeg', clientId: 'cid' });
    expect(h.calls.upload[0]).toBe('acct/c1/u1_cid.jpg');
    expect(h.calls.chat_messages[0]).toMatchObject({ kind: 'image', attachment_path: 'acct/c1/u1_cid.jpg', attachment_mime: 'image/jpeg', voice_duration_ms: null });
  });
  it('requires a duration for voice notes and rejects bad mimes', async () => {
    const blob = new Blob(['x']);
    await expect(sendMedia({ channel, senderId: 'u1', kind: 'voice', blob, mime: 'audio/webm' })).rejects.toBeInstanceOf(ChatError);
    await expect(sendMedia({ channel, senderId: 'u1', kind: 'image', blob, mime: 'text/html', durationMs: 1000 })).rejects.toBeInstanceOf(ChatError);
    expect(h.calls.upload).toBeUndefined();
  });
  it('removes the orphaned file when access was revoked, keeps it for retryable errors', async () => {
    h.state.insert = { data: null, error: { code: '42501' } };
    await expect(sendMedia({ channel, senderId: 'u1', kind: 'voice', blob: new Blob(['x']), mime: 'audio/webm;codecs=opus', durationMs: 2000, clientId: 'v1' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.calls.remove[0]).toEqual(['acct/c1/u1_v1.webm']);
  });
});

describe('getSignedUrls', () => {
  it('batches, de-dupes and caches', async () => {
    h.state.signed = { data: [{ path: 'a', signedUrl: 'https://s/a' }, { path: 'b', signedUrl: 'https://s/b' }], error: null };
    const first = await getSignedUrls(['a', 'b', 'a']);
    expect(first.get('a')).toBe('https://s/a');
    expect(h.calls.sign[0]).toEqual(['a', 'b']);
    await getSignedUrls(['a', 'b']);
    expect(h.calls.sign).toHaveLength(1); // served from cache
  });
});
