import { describe, expect, it } from 'vitest';
import {
  FALLBACK_ICE,
  assessQuality,
  buildJoinUrl,
  buildShare,
  classifyMediaError,
  clipStoragePath,
  effectiveStatus,
  expiresInLabel,
  extractToken,
  formatBytes,
  formatDuration,
  friendlyVideoError,
  hasRelay,
  isValidToken,
  parseSignal,
  pickRecorderMime,
  reconnectDelay,
  recordGate,
  sanitizeIceServers,
  ttlToIso,
  validateDisplayName,
  validateStartForm,
} from './videoSession';

const TOKEN = 'a'.repeat(64);
const NOW = new Date('2027-01-01T12:00:00Z').getTime();
const base = { status: 'waiting' as const, expires_at: '2027-01-01T16:00:00Z', last_heartbeat_at: null, started_at: null, created_at: '2027-01-01T12:00:00Z' };

describe('tokens and links', () => {
  it('validates 64-char hex tokens only', () => {
    expect(isValidToken(TOKEN)).toBe(true);
    expect(isValidToken('abc')).toBe(false);
    expect(isValidToken('G'.repeat(64))).toBe(false);
    expect(isValidToken(undefined)).toBe(false);
  });
  it('builds and parses join URLs', () => {
    const url = buildJoinUrl('https://vireek.com/', TOKEN);
    expect(url).toBe(`https://vireek.com/live/${TOKEN}`);
    expect(extractToken(url)).toBe(TOKEN);
    expect(extractToken(`  ${TOKEN.toUpperCase()} `)).toBe(TOKEN);
    expect(extractToken('nothing here')).toBeNull();
  });
  it('encodes the share message', () => {
    const s = buildShare('https://x.test/live/1', { business: 'Acme HVAC', title: 'Compressor & fan' });
    expect(s.text).toContain('Acme HVAC');
    expect(s.smsHref.startsWith('sms:?&body=')).toBe(true);
    expect(s.mailHref).toContain(encodeURIComponent('Compressor & fan'));
  });
});

describe('effectiveStatus (mirrors SQL)', () => {
  it('expires waiting sessions after expires_at', () => {
    expect(effectiveStatus(base, NOW)).toBe('waiting');
    expect(effectiveStatus({ ...base, expires_at: '2027-01-01T11:59:00Z' }, NOW)).toBe('expired');
  });
  it('treats a live session without a heartbeat for 90s as ended', () => {
    const live = { ...base, status: 'live' as const, started_at: '2027-01-01T11:00:00Z' };
    expect(effectiveStatus({ ...live, last_heartbeat_at: '2027-01-01T11:59:00Z' }, NOW)).toBe('live');
    expect(effectiveStatus({ ...live, last_heartbeat_at: '2027-01-01T11:58:00Z' }, NOW)).toBe('ended');
  });
  it('keeps terminal statuses', () => {
    expect(effectiveStatus({ ...base, status: 'ended' }, NOW)).toBe('ended');
    expect(effectiveStatus({ ...base, status: 'cancelled' }, NOW)).toBe('cancelled');
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('0:00');
  });
  it('formats bytes and expiry', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(expiresInLabel('2027-01-01T12:30:00Z', NOW)).toBe('expires in 30 min');
    expect(expiresInLabel('2027-01-01T16:00:00Z', NOW)).toBe('expires in 4 h');
    expect(expiresInLabel('2026-01-01T00:00:00Z', NOW)).toBe('expired');
  });
});

describe('validation', () => {
  it('requires a sensible display name', () => {
    expect(validateDisplayName(' ')).not.toBeNull();
    expect(validateDisplayName('A')).not.toBeNull();
    expect(validateDisplayName('Sam')).toBeNull();
    expect(validateDisplayName('x'.repeat(61))).not.toBeNull();
  });
  it('validates the start form', () => {
    expect(validateStartForm({ title: '', expertLabel: '' }).title).toBeDefined();
    expect(validateStartForm({ title: 'ok', expertLabel: 'y'.repeat(81) }).expertLabel).toBeDefined();
    expect(validateStartForm({ title: 'ok', expertLabel: '' })).toEqual({});
  });
  it('only allows known TTLs', () => {
    expect(ttlToIso(60, NOW)).toBe(new Date(NOW + 3_600_000).toISOString());
    expect(ttlToIso(99999, NOW)).toBe(new Date(NOW + 240 * 60_000).toISOString());
  });
});

describe('recording', () => {
  it('prefers mp4 and falls back to webm', () => {
    expect(pickRecorderMime((m) => m.startsWith('video/mp4'))?.ext).toBe('mp4');
    expect(pickRecorderMime((m) => m === 'video/webm;codecs=vp8,opus')?.ext).toBe('webm');
    expect(pickRecorderMime(() => false)).toBeNull();
    expect(pickRecorderMime(() => { throw new Error('boom'); })).toBeNull();
  });
  it('builds the storage path the SQL expects', () => {
    expect(clipStoragePath('o', 's', 'c', 'mp4')).toBe('o/s/c.mp4');
  });
  it('gates recording on role, consent, connection and camera', () => {
    const ok = { role: 'technician' as const, recordingAllowed: true, expertConsented: true, connected: true, hasLocalVideo: true, recorderSupported: true };
    expect(recordGate(ok).ok).toBe(true);
    expect(recordGate({ ...ok, role: 'expert' }).ok).toBe(false);
    expect(recordGate({ ...ok, recordingAllowed: false }).reason).toMatch(/turned off/);
    expect(recordGate({ ...ok, expertConsented: false }).reason).toMatch(/agreed/);
    expect(recordGate({ ...ok, connected: false }).ok).toBe(false);
    expect(recordGate({ ...ok, hasLocalVideo: false }).ok).toBe(false);
    expect(recordGate({ ...ok, recorderSupported: false }).ok).toBe(false);
  });
});

describe('connection quality and backoff', () => {
  it('rates quality', () => {
    expect(assessQuality({ rttMs: null, lossPct: null, bitrateKbps: null, expectVideo: true })).toBe('unknown');
    expect(assessQuality({ rttMs: 60, lossPct: 0, bitrateKbps: 900, expectVideo: true })).toBe('good');
    expect(assessQuality({ rttMs: 250, lossPct: 0, bitrateKbps: 900, expectVideo: true })).toBe('fair');
    expect(assessQuality({ rttMs: 60, lossPct: 10, bitrateKbps: 900, expectVideo: true })).toBe('poor');
    expect(assessQuality({ rttMs: 60, lossPct: 0, bitrateKbps: 30, expectVideo: true })).toBe('poor');
  });
  it('backs off exponentially with a cap', () => {
    expect([0, 1, 2, 3, 10].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 10000]);
  });
});

describe('ICE servers', () => {
  it('falls back to STUN for junk input', () => {
    expect(sanitizeIceServers(null)).toBe(FALLBACK_ICE);
    expect(sanitizeIceServers([{ urls: 'http://evil' }, 5])).toBe(FALLBACK_ICE);
  });
  it('keeps valid entries and detects relay', () => {
    const out = sanitizeIceServers([{ urls: ['stun:a.test'] }, { urls: 'turn:b.test', username: 'u', credential: 'c' }]);
    expect(out).toHaveLength(2);
    expect(hasRelay(out)).toBe(true);
    expect(hasRelay(FALLBACK_ICE)).toBe(false);
  });
});

describe('signal parsing (untrusted input)', () => {
  const from = 'peer-aaaaaaaa';
  const to = 'peer-bbbbbbbb';
  it('accepts well-formed messages', () => {
    expect(parseSignal({ type: 'offer', from, to, sdp: 'v=0' })).toMatchObject({ type: 'offer', restart: false });
    expect(parseSignal({ type: 'ice', from, to, candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } })?.type).toBe('ice');
    expect(parseSignal({ type: 'recording', from, on: true })).toEqual({ type: 'recording', from, on: true });
    expect(parseSignal({ type: 'bye', from })).toEqual({ type: 'bye', from });
  });
  it('rejects malformed or oversized messages', () => {
    expect(parseSignal(null)).toBeNull();
    expect(parseSignal({ type: 'offer', from, sdp: 'v=0' })).toBeNull();
    expect(parseSignal({ type: 'offer', from, to, sdp: 'x'.repeat(60_001) })).toBeNull();
    expect(parseSignal({ type: 'nope', from })).toBeNull();
    expect(parseSignal({ type: 'bye', from: '../../x' })).toBeNull();
  });
});

describe('errors', () => {
  it('maps server codes and media errors to friendly copy', () => {
    expect(friendlyVideoError(new Error('session_expired'))).toMatch(/expired/);
    expect(friendlyVideoError({ message: 'x', code: '42501' })).toMatch(/access/);
    expect(friendlyVideoError(new Error('Failed to fetch'))).toMatch(/connection/);
    expect(friendlyVideoError(new Error('weird'), 'fallback')).toBe('fallback');
    expect(classifyMediaError({ name: 'NotAllowedError' }).kind).toBe('denied');
    expect(classifyMediaError({ name: 'NotFoundError' }).kind).toBe('not-found');
    expect(classifyMediaError({ name: 'NotReadableError' }).kind).toBe('in-use');
    expect(classifyMediaError(new Error('x')).kind).toBe('other');
  });
});
