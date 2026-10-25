// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  escapeHtml, hmacSha256Hex, isValidEmail, isValidPackage, mapCheckrEvent, referenceEmail, safeEqual, splitName, verifyWebhookSignature,
} from './engine';

describe('webhook signature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'report.completed' });
  it('accepts a correct signature and rejects tampering', async () => {
    const sig = await hmacSha256Hex('key_123', body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyWebhookSignature(body, sig, 'key_123')).toBe(true);
    expect(await verifyWebhookSignature(body + ' ', sig, 'key_123')).toBe(false);
    expect(await verifyWebhookSignature(body, sig, 'other')).toBe(false);
    expect(await verifyWebhookSignature(body, sig.toUpperCase(), 'key_123')).toBe(true);
  });
  it('rejects missing signature or secret', async () => {
    expect(await verifyWebhookSignature(body, null, 'k')).toBe(false);
    expect(await verifyWebhookSignature(body, 'abc', '')).toBe(false);
  });
  it('compares in constant time on equal length only', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});

describe('mapCheckrEvent', () => {
  const ev = (type: string, object: Record<string, unknown>) => ({ id: 'evt_9', type, data: { object } });
  it('maps a clear report', () => {
    expect(mapCheckrEvent(ev('report.completed', { id: 'r1', candidate_id: 'c1', result: 'clear' }))).toEqual({
      eventId: 'evt_9', type: 'report.completed', candidateId: 'c1', invitationId: null, reportId: 'r1', status: 'complete', result: 'clear',
    });
  });
  it('treats anything other than clear as needing review', () => {
    expect(mapCheckrEvent(ev('report.completed', { id: 'r1', result: 'consider' }))?.result).toBe('consider');
    expect(mapCheckrEvent(ev('report.completed', { id: 'r1', result: 'weird' }))?.result).toBe('consider');
    expect(mapCheckrEvent(ev('report.completed', { id: 'r1' }))?.result).toBe('consider');
  });
  it('maps invitation and in-flight events', () => {
    expect(mapCheckrEvent(ev('invitation.completed', { id: 'i1', candidate_id: 'c1' }))).toMatchObject({ status: 'in_progress', invitationId: 'i1', candidateId: 'c1' });
    expect(mapCheckrEvent(ev('invitation.expired', { id: 'i1' }))?.status).toBe('failed');
    expect(mapCheckrEvent(ev('report.suspended', { id: 'r1' }))?.status).toBe('suspended');
    expect(mapCheckrEvent(ev('report.created', { id: 'r1' }))?.status).toBe('in_progress');
  });
  it('ignores unknown or malformed events', () => {
    expect(mapCheckrEvent(ev('candidate.created', { id: 'c1' }))).toBeNull();
    expect(mapCheckrEvent(ev('invitation.created', { id: 'i1' }))).toBeNull();
    expect(mapCheckrEvent({ type: 'report.completed' })).toBeNull();
    expect(mapCheckrEvent(null)).toBeNull();
    expect(mapCheckrEvent('x')).toBeNull();
  });
});

describe('validators and helpers', () => {
  it('validates package names and emails', () => {
    expect(isValidPackage('tasker_standard')).toBe(true);
    expect(isValidPackage('Bad Package')).toBe(false);
    expect(isValidPackage(5)).toBe(false);
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
  });
  it('splits names', () => {
    expect(splitName('Sam Rivera')).toEqual({ first: 'Sam', last: 'Rivera' });
    expect(splitName('Ana Maria de la Cruz')).toEqual({ first: 'Ana', last: 'Maria de la Cruz' });
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: 'Cher' });
    expect(splitName('  ')).toEqual({ first: '', last: '' });
  });
  it('escapes HTML in the reference email', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    const m = referenceEmail({ refereeName: '<b>Pat</b>', workerName: 'Sam "S" Rivera', url: 'https://x.test/talent/reference/abc' });
    expect(m.html).not.toContain('<b>Pat</b>');
    expect(m.html).toContain('&lt;b&gt;Pat&lt;/b&gt;');
    expect(m.subject).toContain('Sam "S" Rivera');
    expect(m.text).toContain('https://x.test/talent/reference/abc');
  });
});
