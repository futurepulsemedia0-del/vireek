import { describe, it, expect } from 'vitest';
import {
  closeReasonLabel, effectiveStatus, filterSessions, formatPhone, maskingErrorMessage, normalizePhone,
  summarizeNumbers, telHref, timeLeftLabel, validateProxyNumber, validateSessionInput,
  type ProxyNumber, type ProxySession,
} from './callMasking';

const NOW = new Date('2026-10-26T12:00:00Z').getTime();
const H = 3_600_000;
const session = (o: Partial<ProxySession>): ProxySession => ({
  id: 's', proxy_number_id: 'n1', job_id: null, technician_id: 't1', customer_name: 'Ann Smith', technician_name: 'Tom',
  customer_e164: '+15552010001', technician_e164: '+15552010002', status: 'active',
  expires_at: new Date(NOW + 5 * H).toISOString(), closed_at: null, close_reason: null, created_at: new Date(NOW).toISOString(), ...o,
});

describe('normalizePhone (mirrors normalize_phone_e164 in SQL)', () => {
  it.each([['(555) 201-0001', '+15552010001'], ['1-555-201-0001', '+15552010001'], ['+44 20 7946 0958', '+442079460958']])('%s', (i, o) =>
    expect(normalizePhone(i)).toBe(o));
  it.each([['123'], [''], [null], ['055 201 0001'], ['+0123456789']])('rejects %s', (i) => expect(normalizePhone(i as string)).toBeNull());
});

describe('formatting', () => {
  it('formats NANP numbers', () => expect(formatPhone('+15552010001')).toBe('(555) 201-0001'));
  it('leaves international numbers alone', () => expect(formatPhone('+442079460958')).toBe('+442079460958'));
  it('builds tel links', () => expect(telHref('+1 555')).toBe('tel:+1555'));
  it('time left', () => {
    expect(timeLeftLabel(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe('30 min left');
    expect(timeLeftLabel(new Date(NOW + 5 * H).toISOString(), NOW)).toBe('5 h left');
    expect(timeLeftLabel(new Date(NOW + 72 * H).toISOString(), NOW)).toBe('3 days left');
    expect(timeLeftLabel(new Date(NOW - 1).toISOString(), NOW)).toBe('Expired');
  });
  it('close reasons', () => {
    expect(closeReasonLabel('job_cancelled')).toBe('Job cancelled');
    expect(closeReasonLabel(null)).toBe('Closed');
  });
});

describe('validation', () => {
  it('proxy number', () => {
    expect(validateProxyNumber('555 201 0001', ' Main ')).toEqual({ e164: '+15552010001', label: 'Main' });
    expect(validateProxyNumber('abc', '').error).toBeTruthy();
    expect(validateProxyNumber('5552010001', 'x'.repeat(81)).error).toMatch(/80/);
  });
  it('session input', () => {
    const ok = { technicianId: 't', customerName: 'Ann', customerPhone: '5552010001', ttlHours: 72 };
    expect(validateSessionInput(ok)).toBeNull();
    expect(validateSessionInput({ ...ok, technicianId: '' })).toMatch(/technician/i);
    expect(validateSessionInput({ ...ok, customerName: '  ' })).toMatch(/name/i);
    expect(validateSessionInput({ ...ok, customerPhone: '12' })).toMatch(/phone/i);
    expect(validateSessionInput({ ...ok, ttlHours: 5 })).toMatch(/long/i);
  });
});

describe('sessions', () => {
  it('a timed-out active session counts as expired', () => {
    expect(effectiveStatus(session({ expires_at: new Date(NOW - 1).toISOString() }), NOW)).toBe('expired');
    expect(effectiveStatus(session({}), NOW)).toBe('active');
    expect(effectiveStatus(session({ status: 'closed' }), NOW)).toBe('closed');
  });
  it('filters by state and query', () => {
    const list = [
      session({ id: 'a' }),
      session({ id: 'b', status: 'closed', customer_name: 'Bob' }),
      session({ id: 'c', expires_at: new Date(NOW - H).toISOString(), customer_name: 'Cy' }),
    ];
    expect(filterSessions(list, 'active', '', NOW).map((s) => s.id)).toEqual(['a']);
    expect(filterSessions(list, 'ended', '', NOW).map((s) => s.id)).toEqual(['b', 'c']);
    expect(filterSessions(list, 'all', 'bob', NOW).map((s) => s.id)).toEqual(['b']);
    expect(filterSessions(list, 'all', '(555) 201-0001', NOW)).toHaveLength(3);
    expect(filterSessions(list, 'all', 'tom', NOW)).toHaveLength(3);
  });
  it('summarizes the pool', () => {
    const nums = [{ id: 'n1', status: 'active' }, { id: 'n2', status: 'paused' }] as ProxyNumber[];
    expect(summarizeNumbers(nums, { n1: { number_id: 'n1', active_sessions: 3, total_sessions: 9, calls_30d: 1 } }))
      .toEqual({ total: 2, usable: 1, liveSessions: 3 });
  });
});

describe('maskingErrorMessage', () => {
  it('maps database codes to friendly text', () => {
    expect(maskingErrorMessage({ message: 'no_proxy_number_available' })).toMatch(/No free proxy number/);
    expect(maskingErrorMessage({ code: '23505', message: 'dup' })).toMatch(/already registered/);
    expect(maskingErrorMessage({ message: 'something weird' })).toMatch(/Something went wrong/);
    expect(maskingErrorMessage(null)).toMatch(/Something went wrong/);
  });
});
