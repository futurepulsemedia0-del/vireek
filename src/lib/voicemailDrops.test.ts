import { describe, it, expect } from 'vitest';
import {
  MAX_FILE_BYTES,
  audioContentType,
  buildStoragePath,
  deliveryRate,
  filterDrops,
  formatBytes,
  formatDuration,
  getComplianceGaps,
  isComplianceReady,
  sanitizeFileName,
  summarizeLibrary,
  validateAudioFile,
  validateDropName,
  type VoicemailDrop,
  type VoicemailDropStats,
} from './voicemailDrops';

const base: VoicemailDrop = {
  id: 'd1',
  account_owner_id: 'owner-1',
  name: 'Quote follow-up',
  description: null,
  storage_path: 'owner-1/x-quote.mp3',
  file_name: 'quote.mp3',
  mime_type: 'audio/mpeg',
  size_bytes: 1000,
  duration_seconds: 30,
  transcript: null,
  campaign_types: [],
  uses_ai_voice: false,
  discloses_business_name: true,
  includes_callback_number: true,
  includes_opt_out: true,
  consent_confirmed: true,
  compliance_ready: true,
  status: 'active',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  archived_at: null,
};
const drop = (over: Partial<VoicemailDrop> = {}): VoicemailDrop => ({ ...base, ...over });
const stat = (over: Partial<VoicemailDropStats> = {}): VoicemailDropStats => ({
  drop_id: 'd1', total_uses: 0, uses_30d: 0, delivered: 0, failed: 0, last_used_at: null, ...over,
});

describe('validateAudioFile', () => {
  it('accepts mp3 and wav (also when the browser reports no mime type)', () => {
    expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: 1000 })).toBeNull();
    expect(validateAudioFile({ name: 'A.WAV', type: '', size: 1000 })).toBeNull();
    expect(validateAudioFile({ name: 'a.wav', type: 'audio/x-wav', size: 1000 })).toBeNull();
  });
  it('rejects empty, wrong format, wrong mime and oversized files', () => {
    expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: 0 })).toMatch(/empty/i);
    expect(validateAudioFile({ name: 'a.m4a', type: 'audio/mp4', size: 10 })).toMatch(/MP3 or WAV/);
    expect(validateAudioFile({ name: 'a.mp3', type: 'text/plain', size: 10 })).toMatch(/does not look/);
    expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: MAX_FILE_BYTES + 1 })).toMatch(/too large/);
  });
});

describe('validateDropName', () => {
  it('requires a trimmed name of at most 120 characters', () => {
    expect(validateDropName('  ')).not.toBeNull();
    expect(validateDropName('x'.repeat(121))).not.toBeNull();
    expect(validateDropName(' Friendly follow-up ')).toBeNull();
  });
});

describe('compliance', () => {
  it('is ready only when all four flags are set', () => {
    expect(isComplianceReady(base)).toBe(true);
    expect(isComplianceReady({ ...base, includes_opt_out: false })).toBe(false);
  });
  it('lists exactly the missing checklist items', () => {
    expect(getComplianceGaps(base)).toEqual([]);
    const none = { discloses_business_name: false, includes_callback_number: false, includes_opt_out: false, consent_confirmed: false };
    expect(getComplianceGaps(none)).toHaveLength(4);
    expect(getComplianceGaps({ ...none, consent_confirmed: true })).toHaveLength(3);
  });
});

describe('storage paths', () => {
  it('never lets a file name escape the owner folder', () => {
    const safe = sanitizeFileName('../../etc/passwd.mp3');
    expect(safe).not.toContain('/');
    expect(safe.endsWith('.mp3')).toBe(true);
    const path = buildStoragePath('owner-1', '../../evil.wav', 'uid-1');
    expect(path.startsWith('owner-1/uid-1-')).toBe(true);
    expect(path.split('/')).toHaveLength(2);
  });
  it('falls back to a default name for non-latin file names', () => {
    expect(sanitizeFileName('پیام.mp3')).toBe('voicemail.mp3');
  });
  it('derives the stored content type from the extension', () => {
    expect(audioContentType('x.wav')).toBe('audio/wav');
    expect(audioContentType('x.mp3')).toBe('audio/mpeg');
  });
});

describe('formatting', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1572864)).toBe('1.5 MB');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(42)).toBe('0:42');
    expect(formatDuration(125)).toBe('2:05');
  });
});

describe('stats', () => {
  it('computes delivery rate, or null when nothing was attempted', () => {
    expect(deliveryRate(undefined)).toBeNull();
    expect(deliveryRate({ delivered: 0, failed: 0 })).toBeNull();
    expect(deliveryRate({ delivered: 3, failed: 1 })).toBe(75);
  });
  it('summarizes the library across active and archived drops', () => {
    const drops = [
      drop({ id: 'a' }),
      drop({ id: 'b', compliance_ready: false }),
      drop({ id: 'c', status: 'archived' }),
    ];
    const s = summarizeLibrary(drops, {
      a: stat({ drop_id: 'a', uses_30d: 4, delivered: 3, failed: 1 }),
      b: stat({ drop_id: 'b', uses_30d: 1, delivered: 1 }),
    });
    expect(s).toEqual({
      total: 3, active: 2, archived: 1, complianceReady: 1, needsReview: 1, uses30d: 5, deliveryRate: 80,
    });
  });
});

describe('filterDrops', () => {
  const drops = [
    drop({ id: 'a', name: 'Roof quote' }),
    drop({ id: 'b', name: 'Reminder', transcript: 'See you at the ROOF visit' }),
    drop({ id: 'c', name: 'Old one', status: 'archived' }),
  ];
  it('filters by status', () => {
    expect(filterDrops(drops, { status: 'active', query: '' }).map((d) => d.id)).toEqual(['a', 'b']);
    expect(filterDrops(drops, { status: 'archived', query: '' }).map((d) => d.id)).toEqual(['c']);
    expect(filterDrops(drops, { status: 'all', query: '' })).toHaveLength(3);
  });
  it('searches name and transcript, case-insensitively', () => {
    expect(filterDrops(drops, { status: 'all', query: ' roof ' }).map((d) => d.id)).toEqual(['a', 'b']);
  });
});
