import { describe, expect, it } from 'vitest';
import {
  buildStoragePath,
  buildThread,
  canDelete,
  canEdit,
  channelTitle,
  dmOtherUserId,
  extForMime,
  fitWithin,
  formatDuration,
  latestForeignCreatedAt,
  mergeMessages,
  pickRecorderMime,
  previewText,
  receiptFor,
  receiptLabel,
  sortChannels,
  titleWithUnread,
  unreadLabel,
  validateAttachment,
  validateText,
  type ChatChannel,
  type ChatMember,
  type ChatMessage,
  type ChatPerson,
} from '@/lib/teamChat';

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  channel_id: 'c1',
  sender_id: 'u1',
  kind: 'text',
  body: 'hi',
  attachment_path: null,
  attachment_mime: null,
  attachment_bytes: null,
  voice_duration_ms: null,
  client_id: null,
  edited_at: null,
  deleted_at: null,
  created_at: '2026-10-14T10:00:00.000000+00:00',
  ...over,
});

const chan = (over: Partial<ChatChannel> = {}): ChatChannel => ({
  id: 'c1',
  user_id: 'acct',
  kind: 'job',
  job_id: 'j1',
  dm_key: null,
  last_message_at: null,
  last_message_kind: null,
  last_message_preview: null,
  last_message_sender_id: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
});

describe('validateText', () => {
  it('trims and normalises newlines', () => expect(validateText('  a\r\nb  ')).toEqual({ ok: true, text: 'a\nb' }));
  it('rejects blank', () => expect(validateText('  \n ').ok).toBe(false));
  it('rejects over-long', () => expect(validateText('x'.repeat(4001)).ok).toBe(false));
  it('accepts the limit', () => expect(validateText('x'.repeat(4000)).ok).toBe(true));
});

describe('attachments', () => {
  it('accepts jpeg/webm with codec suffix', () => {
    expect(validateAttachment({ type: 'image/jpeg', size: 10 }, 'image')).toBeNull();
    expect(validateAttachment({ type: 'audio/webm;codecs=opus', size: 10 }, 'voice')).toBeNull();
  });
  it('rejects wrong type, empty and oversize', () => {
    expect(validateAttachment({ type: 'application/pdf', size: 10 }, 'image')).toMatch(/photos/);
    expect(validateAttachment({ type: 'image/png', size: 0 }, 'image')).toMatch(/empty/);
    expect(validateAttachment({ type: 'image/png', size: 16 * 1024 * 1024 }, 'image')).toMatch(/too large/);
    expect(validateAttachment({ type: 'image/png', size: 10 }, 'voice')).toMatch(/not supported/);
  });
  it('maps mimes to extensions', () => {
    expect(extForMime('audio/mp4')).toBe('m4a');
    expect(extForMime('audio/webm;codecs=opus')).toBe('webm');
    expect(extForMime('x/y')).toBe('bin');
  });
  it('builds the exact path shape the storage policy requires', () => {
    expect(buildStoragePath({ accountId: 'A', channelId: 'C', senderId: 'S', mime: 'image/jpeg', uniqueId: 'U' })).toBe('A/C/S_U.jpg');
  });
  it('fits within a max edge without upscaling', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 10, 1600)).toEqual({ width: 0, height: 0 });
  });
  it('picks the first supported recorder mime, tolerating throws', () => {
    expect(pickRecorderMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecorderMime(() => false)).toBeNull();
    expect(
      pickRecorderMime(() => {
        throw new Error('x');
      }),
    ).toBeNull();
  });
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_400)).toBe('1:05');
  });
});

describe('channels', () => {
  const people = new Map<string, ChatPerson>([['u2', { user_id: 'u2', name: 'Tom', role: 'technician', is_self: false }]]);
  it('finds the other DM participant', () => {
    expect(dmOtherUserId('u1:u2', 'u1')).toBe('u2');
    expect(dmOtherUserId('u1:u2', 'u2')).toBe('u1');
    expect(dmOtherUserId('u1:u2', 'u3')).toBeNull();
    expect(dmOtherUserId(null, 'u1')).toBeNull();
  });
  it('titles job and direct channels', () => {
    expect(channelTitle(chan({ job: { customer_name: 'Acme', service_type: 'HVAC' } }), 'u1', people)).toBe('Acme · HVAC');
    expect(channelTitle(chan({ job: null }), 'u1', people)).toBe('Job chat');
    expect(channelTitle(chan({ kind: 'direct', job_id: null, dm_key: 'u1:u2' }), 'u1', people)).toBe('Tom');
    expect(channelTitle(chan({ kind: 'direct', job_id: null, dm_key: 'u1:zz' }), 'u1', people)).toBe('Direct message');
  });
  it('previews by kind', () => {
    expect(previewText('image', null)).toBe('Photo');
    expect(previewText('voice', null, 'Tom')).toBe('Tom: Voice note');
    expect(previewText('text', 'a\n b', 'You')).toBe('You: a b');
    expect(previewText('text', 'x', null, true)).toBe('Message deleted');
    expect(previewText(null, null)).toBe('');
  });
  it('sorts by recency, channels without messages last', () => {
    const a = chan({ id: 'a', last_message_at: '2026-10-10T00:00:00Z' });
    const b = chan({ id: 'b', last_message_at: '2026-10-12T00:00:00Z' });
    const c = chan({ id: 'c', last_message_at: null, created_at: '2026-10-14T00:00:00Z' });
    expect(sortChannels([c, a, b]).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });
  it('formats unread badges', () => {
    expect(unreadLabel(120)).toBe('99+');
    expect(titleWithUnread('Vireek', 3)).toBe('(3) Vireek');
    expect(titleWithUnread('Vireek', 0)).toBe('Vireek');
  });
});

describe('mergeMessages', () => {
  it('replaces an optimistic message by (sender, client_id) — never duplicates', () => {
    const local = msg({ id: 'local-x', client_id: 'x', status: 'sending', created_at: '2026-10-14T10:00:00.100Z' });
    const server = msg({ id: 'srv1', client_id: 'x', created_at: '2026-10-14T10:00:00.200000+00:00' });
    expect(mergeMessages([local], [server])).toEqual([server]);
    // realtime event arriving BEFORE the insert response, then the response:
    const once = mergeMessages([local], [server]);
    expect(mergeMessages(once, [server])).toHaveLength(1);
  });
  it('does not merge the same client_id from different senders', () => {
    const a = msg({ id: 'a', sender_id: 'u1', client_id: 'x' });
    const b = msg({ id: 'b', sender_id: 'u2', client_id: 'x', created_at: '2026-10-14T10:00:01+00:00' });
    expect(mergeMessages([a], [b])).toHaveLength(2);
  });
  it('orders by time across mixed timestamp formats and breaks ties by id', () => {
    const z = msg({ id: 'z', created_at: '2026-10-14T10:00:00.500Z' });
    const s = msg({ id: 's', created_at: '2026-10-14T10:00:00.400000+00:00' });
    expect(mergeMessages([z], [s]).map((m) => m.id)).toEqual(['s', 'z']);
    const t1 = msg({ id: 'b', created_at: '2026-10-14T10:00:00+00:00' });
    const t2 = msg({ id: 'a', created_at: '2026-10-14T10:00:00+00:00' });
    expect(mergeMessages([t1], [t2]).map((m) => m.id)).toEqual(['a', 'b']);
  });
  it('applies edits and keeps tombstones', () => {
    const orig = msg({ id: 'm', body: 'one' });
    const edited = msg({ id: 'm', body: 'two', edited_at: '2026-10-14T10:01:00Z' });
    expect(mergeMessages([orig], [edited])[0].body).toBe('two');
    const deleted = msg({ id: 'm', body: null, deleted_at: '2026-10-14T10:02:00Z' });
    expect(mergeMessages([deleted], [orig])[0].deleted_at).not.toBeNull();
  });
});

describe('buildThread', () => {
  const now = new Date('2026-10-14T18:00:00Z');
  it('adds day separators and groups by sender within 5 minutes', () => {
    const items = buildThread(
      [
        msg({ id: '1', created_at: '2026-10-14T10:00:00Z' }),
        msg({ id: '2', created_at: '2026-10-14T10:02:00Z' }),
        msg({ id: '3', created_at: '2026-10-14T10:09:00Z' }),
        msg({ id: '4', sender_id: 'u2', created_at: '2026-10-14T10:09:30Z' }),
      ],
      now,
      'en-US',
    );
    const messages = items.filter((i) => i.type === 'message') as Extract<(typeof items)[number], { type: 'message' }>[];
    expect(items[0]).toMatchObject({ type: 'day' });
    expect(messages.map((m) => m.showSender)).toEqual([true, false, true, true]);
    expect(messages.map((m) => m.endsGroup)).toEqual([false, true, true, true]);
  });
  it('starts a new group on a new day', () => {
    const items = buildThread(
      [msg({ id: '1', created_at: '2026-10-13T23:59:00Z' }), msg({ id: '2', created_at: '2026-10-14T00:01:00Z' })],
      new Date('2026-10-14T12:00:00Z'),
      'en-US',
    );
    expect(items.filter((i) => i.type === 'day')).toHaveLength(2);
  });
});

describe('receipts', () => {
  const members: ChatMember[] = [
    { channel_id: 'c1', user_id: 'u1', last_read_at: '2026-10-14T10:05:00Z', muted: false },
    { channel_id: 'c1', user_id: 'u2', last_read_at: '2026-10-14T10:00:30Z', muted: false },
    { channel_id: 'c1', user_id: 'u3', last_read_at: '2026-10-14T09:00:00Z', muted: false },
  ];
  const m = msg({ sender_id: 'u1', created_at: '2026-10-14T10:00:00Z' });
  it('derives read state from last_read_at, excluding the sender', () => {
    expect(receiptFor(m, members)).toEqual({ state: 'read', readBy: ['u2'] });
    expect(receiptFor(msg({ sender_id: 'u1', created_at: '2026-10-14T10:10:00Z' }), members).state).toBe('sent');
  });
  it('reports local states', () => {
    expect(receiptFor(msg({ status: 'sending' }), members).state).toBe('sending');
    expect(receiptFor(msg({ status: 'failed' }), members).state).toBe('failed');
  });
  it('labels', () => {
    const names = new Map([['u2', 'Tom'], ['u3', 'Tina']]);
    expect(receiptLabel({ state: 'read', readBy: ['u2'] }, names, true)).toBe('Read');
    expect(receiptLabel({ state: 'read', readBy: ['u2'] }, names, false)).toBe('Read by Tom');
    expect(receiptLabel({ state: 'read', readBy: ['u2', 'u3', 'x'] }, names, false)).toBe('Read by Tom and 2 others');
    expect(receiptLabel({ state: 'sent', readBy: [] }, names, false)).toBe('Sent');
  });
  it('finds the newest foreign confirmed message', () => {
    const list = [msg({ id: '1', sender_id: 'u2', created_at: 'a' }), msg({ id: '2', sender_id: 'u1', created_at: 'b' }), msg({ id: '3', sender_id: 'u2', created_at: 'c', status: 'sending' })];
    expect(latestForeignCreatedAt(list, 'u1')).toBe('a');
    expect(latestForeignCreatedAt([], 'u1')).toBeNull();
  });
});

describe('edit / delete rules', () => {
  const now = new Date('2026-10-14T10:10:00Z').getTime();
  it('allows editing own text within 15 minutes only', () => {
    expect(canEdit(msg(), 'u1', now)).toBe(true);
    expect(canEdit(msg(), 'u2', now)).toBe(false);
    expect(canEdit(msg(), 'u1', now + 20 * 60_000)).toBe(false);
    expect(canEdit(msg({ kind: 'image' }), 'u1', now)).toBe(false);
    expect(canEdit(msg({ status: 'sending' }), 'u1', now)).toBe(false);
  });
  it('allows deleting own confirmed non-system messages', () => {
    expect(canDelete(msg(), 'u1')).toBe(true);
    expect(canDelete(msg(), 'u2')).toBe(false);
    expect(canDelete(msg({ deleted_at: 'x' }), 'u1')).toBe(false);
    expect(canDelete(msg({ kind: 'system' }), 'u1')).toBe(false);
  });
});
