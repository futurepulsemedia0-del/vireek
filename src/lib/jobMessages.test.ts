import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  baseMime, buildMediaPath, dayLabel, formatDuration, mergeMessages, mimeToExt, pickRecorderMime,
  previewText, shouldShowDayDivider, validatePhoto, type JobMessage,
} from './jobMessages';

const msg = (over: Partial<JobMessage>): JobMessage => ({
  id: 'a', job_id: 'j', sender_user_id: 'u', sender_role: 'technician', kind: 'text', body: 'hi',
  media_path: null, media_mime: null, media_duration_ms: null, client_id: null, created_at: '2027-04-02T10:00:00Z', ...over,
});

describe('media helpers', () => {
  it('strips codec params so the storage allow-list accepts the type', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(mimeToExt('audio/webm;codecs=opus')).toBe('webm');
    expect(mimeToExt('audio/mp4')).toBe('m4a');
    expect(mimeToExt('weird/type')).toBe('bin');
  });

  it('builds {owner}/{job}/{file} paths that match the storage RLS convention', () => {
    expect(buildMediaPath('owner1', 'job1', 'image/jpeg')).toMatch(/^owner1\/job1\/[0-9a-f-]{36}\.jpg$/);
  });

  it('prefers opus webm, falls back to mp4 (iOS), else undefined', () => {
    expect(pickRecorderMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickRecorderMime((m) => m === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecorderMime(() => false)).toBeUndefined();
  });

  it('validates photos', () => {
    expect(validatePhoto({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(validatePhoto({ type: 'application/pdf', size: 1000 })).toMatch(/image/i);
    expect(validatePhoto({ type: 'image/png', size: 16 * 1024 * 1024 })).toMatch(/15 MB/);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_400)).toBe('1:05');
    expect(formatDuration(null)).toBe('0:00');
  });

  it('labels days', () => {
    const now = new Date(2027, 3, 2, 12);
    expect(dayLabel(new Date(2027, 3, 2, 8).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(2027, 3, 1, 8).toISOString(), now)).toBe('Yesterday');
  });

  it('previews the last message from the viewer perspective', () => {
    const base = { last_body: 'On my way', last_kind: 'text' as const, last_sender_role: 'technician' as const };
    expect(previewText(base, 'technician')).toBe('You: On my way');
    expect(previewText(base, 'office')).toBe('On my way');
    expect(previewText({ ...base, last_kind: 'audio' }, 'office')).toContain('Voice note');
    expect(previewText({ last_body: null, last_kind: null, last_sender_role: null }, 'office')).toBe('No messages yet');
  });
});

describe('mergeMessages', () => {
  it('replaces the optimistic row with the server row (same client_id) — no duplicate', () => {
    const optimistic = msg({ id: 'local-c1', client_id: 'c1' });
    const saved = msg({ id: 'real-1', client_id: 'c1', created_at: '2027-04-02T10:00:01Z' });
    const merged = mergeMessages([optimistic], [saved]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('real-1');
  });

  it('dedupes a realtime echo and keeps chronological order', () => {
    const a = msg({ id: 'a', created_at: '2027-04-02T10:00:00Z' });
    const b = msg({ id: 'b', created_at: '2027-04-02T10:05:00Z' });
    expect(mergeMessages([b], [a, b]).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('shows a day divider only when the day changes', () => {
    const a = msg({ created_at: new Date(2027, 3, 1, 9).toISOString() });
    const b = msg({ created_at: new Date(2027, 3, 1, 18).toISOString() });
    const c = msg({ created_at: new Date(2027, 3, 2, 9).toISOString() });
    expect(shouldShowDayDivider(undefined, a)).toBe(true);
    expect(shouldShowDayDivider(a, b)).toBe(false);
    expect(shouldShowDayDivider(b, c)).toBe(true);
  });
});
