import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: false }));

import {
  MAX_RECORD_SECONDS,
  MAX_VIDEO_BYTES,
  createProgressReporter,
  describeEngagement,
  formatBytes,
  formatDuration,
  friendlyVideoError,
  pickRecorderMime,
  uploadErrorMessage,
} from '@/lib/quoteVideo';
import {
  buildRoomName,
  buildStoragePath,
  canCustomerJoin,
  clampRetentionDays,
  isPathForQuote,
  isPurgeDue,
  isUuid,
  liveSessionState,
  normalizeVideoMime,
  parseEventBody,
  progressStep,
  retentionExpiry,
  sanitizeDisplayName,
  validateUpload,
  watchPercent,
} from '../../supabase/functions/_shared/quote-video/engine';

const OWNER = '3f2b8a0e-1c4d-4e6f-8a9b-0c1d2e3f4a5b';
const QUOTE = '4a3c9b1f-2d5e-4f70-9bac-1d2e3f4a5b6c';
const VIDEO = '5b4d0c20-3e6f-4081-8cbd-2e3f4a5b6c7d';
const day = 86_400_000;

describe('mime + upload validation', () => {
  it('strips codec params and maps browser quirks', () => {
    expect(normalizeVideoMime('video/webm;codecs=vp9,opus')).toBe('video/webm');
    expect(normalizeVideoMime('video/x-m4v')).toBe('video/mp4');
    expect(normalizeVideoMime('', 'clip.MOV')).toBe('video/quicktime');
    expect(normalizeVideoMime('application/pdf')).toBeNull();
  });

  it('rejects wrong type, empty, oversized and too-long files', () => {
    expect(validateUpload({ type: 'image/png', sizeBytes: 10 })).toEqual({ ok: false, code: 'TYPE' });
    expect(validateUpload({ type: 'video/mp4', sizeBytes: 0 })).toEqual({ ok: false, code: 'EMPTY' });
    expect(validateUpload({ type: 'video/mp4', sizeBytes: MAX_VIDEO_BYTES + 1 })).toEqual({ ok: false, code: 'SIZE' });
    expect(validateUpload({ type: 'video/mp4', sizeBytes: 5, durationSeconds: 601 })).toEqual({ ok: false, code: 'DURATION' });
    expect(validateUpload({ type: 'video/mp4', sizeBytes: 5, durationSeconds: null })).toEqual({ ok: true, mime: 'video/mp4' });
  });

  it('has copy for every rejection code', () => {
    for (const code of ['TYPE', 'SIZE', 'EMPTY', 'DURATION'] as const) expect(uploadErrorMessage(code).length).toBeGreaterThan(5);
  });
});

describe('storage paths', () => {
  it('builds paths that pass the same check the SQL regex enforces', () => {
    const path = buildStoragePath(OWNER, QUOTE, VIDEO, 'video/webm');
    expect(path).toBe(`${OWNER}/${QUOTE}/${VIDEO}.webm`);
    expect(isPathForQuote(path, OWNER, QUOTE)).toBe(true);
  });

  it('rejects other accounts, other quotes and traversal', () => {
    const other = '6c5e1d31-4f70-4192-9dce-3f4a5b6c7d8e';
    expect(isPathForQuote(`${other}/${QUOTE}/a.mp4`, OWNER, QUOTE)).toBe(false);
    expect(isPathForQuote(`${OWNER}/${other}/a.mp4`, OWNER, QUOTE)).toBe(false);
    expect(isPathForQuote(`${OWNER}/${QUOTE}/../x.mp4`, OWNER, QUOTE)).toBe(false);
    expect(isPathForQuote(`${OWNER}/${QUOTE}/a/b.mp4`, OWNER, QUOTE)).toBe(false);
    expect(isPathForQuote(undefined, OWNER, QUOTE)).toBe(false);
  });
});

describe('watch progress', () => {
  it('computes clamped whole percentages', () => {
    expect(watchPercent(30, 120)).toBe(25);
    expect(watchPercent(500, 120)).toBe(100);
    expect(watchPercent(5, 0)).toBe(0);
    expect(watchPercent(Number.NaN, 10)).toBe(0);
  });

  it('maps percentages onto reporting steps', () => {
    expect([0, 24, 25, 50, 75, 89, 90, 99, 100].map(progressStep)).toEqual([0, 0, 25, 50, 75, 75, 90, 90, 100]);
  });

  it('reports each step exactly once, in order, even if playback seeks', () => {
    const seen: number[] = [];
    const r = createProgressReporter((s) => seen.push(s));
    r.update(10, 100);
    r.update(30, 100);
    r.update(31, 100);
    r.update(95, 100);
    r.update(10, 100); // seek back: no repeat
    r.update(100, 100);
    expect(seen).toEqual([25, 90, 100]);
  });
});

describe('event parsing (public endpoint)', () => {
  it('accepts valid events and clamps progress', () => {
    expect(parseEventBody({ video_id: VIDEO, event: 'progress', progress: 250 })).toMatchObject({ ok: true, progress: 100 });
    expect(parseEventBody({ video_id: VIDEO, event: 'viewed' })).toMatchObject({ ok: true, progress: null, name: null });
  });

  it('requires a name to acknowledge and sanitises it', () => {
    expect(parseEventBody({ video_id: VIDEO, event: 'acknowledged', name: '   ' })).toEqual({ ok: false, error: 'NAME_REQUIRED' });
    expect(parseEventBody({ video_id: VIDEO, event: 'acknowledged', name: ' Jane\n\tDoe ' })).toMatchObject({ ok: true, name: 'Jane Doe' });
  });

  it('rejects junk', () => {
    expect(parseEventBody(null)).toEqual({ ok: false, error: 'INVALID_BODY' });
    expect(parseEventBody({ video_id: 'nope', event: 'viewed' })).toEqual({ ok: false, error: 'INVALID_VIDEO' });
    expect(parseEventBody({ video_id: VIDEO, event: 'delete' })).toEqual({ ok: false, error: 'INVALID_EVENT' });
    expect(parseEventBody({ video_id: VIDEO, event: 'progress', progress: 'x' })).toEqual({ ok: false, error: 'INVALID_PROGRESS' });
    expect(isUuid(VIDEO)).toBe(true);
  });

  it('sanitises display names', () => {
    expect(sanitizeDisplayName('x'.repeat(100), 'fb')).toHaveLength(60);
    expect(sanitizeDisplayName(42, 'fb')).toBe('fb');
  });
});

describe('retention rules', () => {
  const created = new Date('2027-01-01T00:00:00Z');
  const responded = new Date('2027-03-01T00:00:00Z');

  it('clamps the retention window', () => {
    expect(clampRetentionDays(5)).toBe(30);
    expect(clampRetentionDays(99999)).toBe(1825);
    expect(clampRetentionDays('abc')).toBe(365);
  });

  it('counts from the later of upload and response', () => {
    expect(retentionExpiry(created, null, 100).getTime()).toBe(created.getTime() + 100 * day);
    expect(retentionExpiry(created, responded, 100).getTime()).toBe(responded.getTime() + 100 * day);
    expect(retentionExpiry(responded, created, 100).getTime()).toBe(responded.getTime() + 100 * day);
  });

  it('purges expired, deleted and orphaned videos - but never under legal hold', () => {
    const base = { createdAt: created, respondedAt: null, retentionDays: 30, deletedAt: null, quoteDeleted: false, legalHold: false };
    const later = new Date(created.getTime() + 31 * day);
    expect(isPurgeDue({ ...base, now: new Date(created.getTime() + 29 * day) })).toBe(false);
    expect(isPurgeDue({ ...base, now: later })).toBe(true);
    expect(isPurgeDue({ ...base, now: created, deletedAt: created })).toBe(true);
    expect(isPurgeDue({ ...base, now: created, quoteDeleted: true })).toBe(true);
    expect(isPurgeDue({ ...base, now: later, legalHold: true })).toBe(false);
    expect(isPurgeDue({ ...base, now: later, legalHold: true, deletedAt: created })).toBe(false);
  });
});

describe('live sessions', () => {
  const now = new Date('2027-01-01T12:00:00Z');
  const live = { status: 'live', expires_at: '2027-01-01T13:00:00Z', customer_join_count: 0 };

  it('derives state from status + expiry', () => {
    expect(liveSessionState(null, now)).toBe('none');
    expect(liveSessionState(live, now)).toBe('live');
    expect(liveSessionState({ ...live, expires_at: '2027-01-01T11:59:59Z' }, now)).toBe('expired');
    expect(liveSessionState({ ...live, status: 'ended' }, now)).toBe('ended');
  });

  it('caps customer joins', () => {
    expect(canCustomerJoin(live, now)).toBe(true);
    expect(canCustomerJoin({ ...live, customer_join_count: 12 }, now)).toBe(false);
    expect(canCustomerJoin({ ...live, status: 'ended' }, now)).toBe(false);
  });

  it('builds non-identifying room names', () => {
    expect(buildRoomName('AB12-cd34zz')).toBe('vq-ab12cd34');
    expect(buildRoomName('0123456789abcdef0123456789abcdef')).toHaveLength(27);
  });
});

describe('presentation helpers', () => {
  it('formats duration and size', () => {
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(null)).toBe('\u2014');
    expect(formatDuration(MAX_RECORD_SECONDS)).toBe('3:00');
    expect(formatBytes(512)).toBe('1 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('describes what the customer actually did', () => {
    const base = { shared: true, view_count: 0, max_progress: 0, acknowledged_at: null, acknowledged_name: null };
    expect(describeEngagement({ ...base, shared: false }).tone).toBe('neutral');
    expect(describeEngagement(base).label).toMatch(/not opened/i);
    expect(describeEngagement({ ...base, view_count: 2, max_progress: 50 }).label).toMatch(/50%/);
    expect(describeEngagement({ ...base, view_count: 1, max_progress: 95 }).label).toMatch(/not acknowledged/i);
    expect(describeEngagement({ ...base, max_progress: 100, acknowledged_at: 'x', acknowledged_name: 'Jane' })).toEqual({
      label: 'Watched and acknowledged by Jane',
      tone: 'success',
    });
  });

  it('maps error codes and falls back safely', () => {
    expect(friendlyVideoError('QUOTE_VIDEO_LIMIT')).toMatch(/up to 5/);
    expect(friendlyVideoError('ERROR: FORBIDDEN')).toMatch(/permission/);
    expect(friendlyVideoError('weird')).toMatch(/try again/i);
    expect(friendlyVideoError(null, 'fb')).toBe('fb');
  });

  it('picks the first supported recorder mime', () => {
    expect(pickRecorderMime(undefined)).toBeUndefined();
    expect(pickRecorderMime((t) => t === 'video/mp4')).toBe('video/mp4');
    expect(pickRecorderMime(() => true)).toBe('video/webm;codecs=vp9,opus');
    expect(pickRecorderMime(() => false)).toBeUndefined();
  });
});
