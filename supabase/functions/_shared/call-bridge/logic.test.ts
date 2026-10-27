import { describe, expect, it } from 'vitest';
import { callbackUrl, dialTwiml, last4, mapTwilioStatus, normalizeE164, parseDuration, sayHangup, xmlEscape } from './logic';

describe('normalizeE164', () => {
  it.each([
    ['(555) 201-0001', '+15552010001'],
    ['555-201-0001', '+15552010001'],
    ['1 555 201 0001', '+15552010001'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s -> %s', (i, o) => expect(normalizeE164(i)).toBe(o));
  it.each([['123'], [''], [null], [undefined], ['+0123456789'], ['055 201 0001']])('rejects %s', (i) =>
    expect(normalizeE164(i as string)).toBeNull());
});

describe('helpers', () => {
  it('last4 never leaks more than four digits', () => expect(last4('+15552010001')).toBe('0001'));
  it('xmlEscape escapes markup', () => expect(xmlEscape(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;'));
  it('maps twilio statuses', () => {
    expect(mapTwilioStatus('no-answer')).toBe('no_answer');
    expect(mapTwilioStatus('in-progress')).toBe('in_progress');
    expect(mapTwilioStatus('weird')).toBe('failed');
    expect(mapTwilioStatus(undefined)).toBe('failed');
  });
  it('parseDuration is defensive', () => {
    expect(parseDuration('42')).toBe(42);
    expect(parseDuration('-1')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('999999')).toBeNull();
  });
  it('callbackUrl encodes params', () => expect(callbackUrl('https://x/f', 'status', { s: 'a b' })).toBe('https://x/f?action=status&s=a+b'));
  it('sayHangup escapes', () => expect(sayHangup('a < b')).toBe('<Say>a &lt; b</Say><Hangup/>'));
});

describe('dialTwiml', () => {
  it('builds a bridged dial with caller id', () => {
    const x = dialTwiml({ callerId: '+15559990001', number: '+15552010001', action: 'https://x/f?action=status&a=1' });
    expect(x).toContain('callerId="+15559990001"');
    expect(x).toContain('<Number>+15552010001</Number>');
    expect(x).toContain('action="https://x/f?action=status&amp;a=1"');
  });
  it('clamps timeout', () => expect(dialTwiml({ callerId: '+15559990001', number: '+15552010001', action: 'u', timeout: 999 })).toContain('timeout="60"'));
  it('refuses non E.164 numbers (no arbitrary dialing)', () => {
    expect(() => dialTwiml({ callerId: '+15559990001', number: '5552010001', action: 'u' })).toThrow();
    expect(() => dialTwiml({ callerId: 'x', number: '+15552010001', action: 'u' })).toThrow();
  });
});
