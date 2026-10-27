import { describe, expect, it } from 'vitest';
import {
  blockedDestination, buildBridgeTwiml, buildLeadNotes, countryAllowed, jwtClaims, leadMatchFilter, mapProviderStatus,
  mapTwilioError, maskPhone, mfaState, normalizeLeadInput, phoneVariants, pickCallerId, rateLimitDecision, safePageUrl, toE164,
} from './logic';

const rid = 'req_12345678';

describe('toE164', () => {
  it.each([
    ['+15551234567', '+15551234567'], ['(555) 123-4567', '+15551234567'], ['1-555-123-4567', '+15551234567'],
    ['0044 20 7946 0958', '+442079460958'], ['+44 20 7946 0958', '+442079460958'],
  ])('%s', (i, o) => expect(toE164(i)).toBe(o));
  it.each(['', 'abc', '12345', '+0123456789', null, 5551234567])('rejects %s', (i) => expect(toE164(i)).toBeNull());
});

describe('destinations', () => {
  it('blocks premium, service and malformed NANP numbers', () => {
    expect(blockedDestination('+19005551234')).toBe('premium_rate');
    expect(blockedDestination('+19765551234')).toBe('premium_rate');
    expect(blockedDestination('+14115551234')).toBe('service_code');
    expect(blockedDestination('+10555551234')).toBe('invalid_number');
    expect(blockedDestination('+12120555123')).toBe('invalid_number');
    expect(blockedDestination('+442079460958')).toBeNull();
    expect(blockedDestination('+12125551234')).toBeNull();
  });
  it('enforces the country allow-list and defaults to +1', () => {
    expect(countryAllowed('+12125551234', undefined)).toBe(true);
    expect(countryAllowed('+442079460958', ['+1'])).toBe(false);
    expect(countryAllowed('+442079460958', ['+1', '+44'])).toBe(true);
  });
});

describe('helpers', () => {
  it('masks numbers, picks caller id, rate limits', () => {
    expect(maskPhone('+15551234567')).toBe('+1\u2022\u2022\u2022\u2022567');
    expect(pickCallerId([null, 'bad', '+15550001111'])).toBe('+15550001111');
    expect(pickCallerId([])).toBeNull();
    expect(rateLimitDecision({ minuteCount: 5, dayCount: 0, perMinute: 5, perDay: 100 })).toMatchObject({ ok: false, scope: 'minute' });
    expect(rateLimitDecision({ minuteCount: 1, dayCount: 100, perMinute: 5, perDay: 100 })).toMatchObject({ ok: false, scope: 'day' });
    expect(rateLimitDecision({ minuteCount: 1, dayCount: 1, perMinute: 5, perDay: 100 })).toEqual({ ok: true });
  });
  it('maps provider statuses and errors', () => {
    expect(mapProviderStatus('in-progress')).toBe('answered');
    expect(mapProviderStatus('no-answer')).toBe('no_answer');
    expect(mapTwilioError('Twilio 400: {"code":21212}').code).toBe('caller_id_not_verified');
    expect(mapTwilioError('Twilio 401: x').code).toBe('calling_not_configured');
    expect(mapTwilioError('boom').code).toBe('provider_error');
  });
});

describe('buildBridgeTwiml', () => {
  it('escapes the whisper and only emits validated numbers', () => {
    const x = buildBridgeTwiml({ customerE164: '+15551234567', callerId: '+15550001111', whisper: 'Call </Say><Hangup/> "x" & y' });
    expect(x).not.toContain('<Hangup');
    expect(x).toContain('<Number>+15551234567</Number>');
    expect(x).toContain('callerId="+15550001111"');
  });
  it('throws on invalid numbers', () => {
    expect(() => buildBridgeTwiml({ customerE164: 'x', callerId: '+15550001111', whisper: '' })).toThrow();
  });
});

describe('lead capture', () => {
  it('requires a request id and contact info', () => {
    expect(normalizeLeadInput({})).toMatchObject({ ok: false, field: 'request_id' });
    expect(normalizeLeadInput({ request_id: rid })).toMatchObject({ ok: false, field: 'name' });
    expect(normalizeLeadInput({ request_id: rid, phone: '12' })).toMatchObject({ ok: false, field: 'phone' });
    expect(normalizeLeadInput({ request_id: rid, email: 'nope' })).toMatchObject({ ok: false, field: 'email' });
  });
  it('normalizes and derives a name', () => {
    const r = normalizeLeadInput({ request_id: rid, phone: '(555) 123-4567', email: ' A@B.com ', page_url: 'https://x.com/p?token=1#h' });
    expect(r.ok && r.value).toMatchObject({ name: 'Lead 4567', phone: '+15551234567', email: 'a@b.com', pageUrl: 'https://x.com/p', pageHost: 'x.com' });
  });
  it('drops non-http page urls and strips control chars', () => {
    expect(safePageUrl('javascript:alert(1)')).toBeNull();
    const r = normalizeLeadInput({ request_id: rid, name: 'Jo\u0000hn', phone: '+15551234567' });
    expect(r.ok && r.value.name).toBe('John');
  });
  it('builds notes and match filters safely', () => {
    const r = normalizeLeadInput({ request_id: rid, name: 'A', phone: '+15551234567', note: 'hi', page_url: 'https://x.com/a' });
    if (!r.ok) throw new Error('x');
    expect(buildLeadNotes(r.value, 'Sam', '2026-10-26T00:00:00Z')).toContain('Captured with the Chrome extension by Sam on 2026-10-26');
    expect(phoneVariants('+15551234567')).toContain('(555) 123-4567');
    const f = leadMatchFilter('+15551234567', 'a"b%@x.com') as string;
    expect(f).toContain('phone.eq."(555) 123-4567"');
    expect(f).toContain('email.ilike."ab@x.com"');
    expect(leadMatchFilter(null, null)).toBeNull();
  });
});

describe('jwt / mfa', () => {
  const tok = (p: object) => `h.${btoa(JSON.stringify(p)).replace(/=+$/, '')}.s`;
  it('reads claims and evaluates MFA', () => {
    expect(jwtClaims(`Bearer ${tok({ aal: 'aal1' })}`)).toEqual({ aal: 'aal1' });
    expect(jwtClaims('garbage')).toBeNull();
    expect(mfaState({ aal: 'aal1' }, [])).toEqual({ required: false, satisfied: true });
    expect(mfaState({ aal: 'aal1' }, [{ status: 'verified' }])).toEqual({ required: true, satisfied: false });
    expect(mfaState({ aal: 'aal2' }, [{ status: 'verified' }])).toEqual({ required: true, satisfied: true });
  });
});
