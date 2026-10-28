import { describe, expect, it } from 'vitest';
import {
  appendIvrPath, decideIvr, ivrDepth, ivrPromptText, ivrRetryMessage, parseDestination, toIvrMenuConfig,
  IVR_MAX_DEPTH, type IvrMenuConfig,
} from './logic';

const EXT = '11111111-1111-4111-8111-111111111111';
const GRP = '22222222-2222-4222-8222-222222222222';
const SUB = '33333333-3333-4333-8333-333333333333';

const menu: IvrMenuConfig = {
  maxRetries: 2,
  timeoutDestination: { type: 'voicemail' },
  invalidDestination: { type: 'external', number: '+15550001111' },
  options: [
    { digit: '1', label: 'sales', destination: { type: 'ring_group', id: GRP } },
    { digit: '2', label: 'emergency service', destination: { type: 'ring_group', id: GRP }, closedDestination: { type: 'external', number: '+15550002222' } },
    { digit: '3', label: 'billing', destination: { type: 'ivr', id: SUB } },
    { digit: '0', label: 'the operator', destination: { type: 'extension', id: EXT } },
  ],
};
const base = { attempt: 0, open: true, depth: 0 };

describe('decideIvr', () => {
  it('routes a valid digit', () =>
    expect(decideIvr(menu, { ...base, digits: '1' })).toEqual({ kind: 'route', digit: '1', destination: { type: 'ring_group', id: GRP }, afterHours: false }));
  it('uses the option closed destination after hours', () =>
    expect(decideIvr(menu, { ...base, open: false, digits: '2' })).toEqual({ kind: 'route', digit: '2', destination: { type: 'external', number: '+15550002222' }, afterHours: true }));
  it('keeps the normal destination after hours when no closed one is set', () =>
    expect(decideIvr(menu, { ...base, open: false, digits: '1' })).toMatchObject({ kind: 'route', afterHours: false }));
  it('retries on an invalid digit, then falls back to the invalid destination', () => {
    expect(decideIvr(menu, { ...base, digits: '9' })).toEqual({ kind: 'retry', reason: 'invalid', attempt: 1 });
    expect(decideIvr(menu, { ...base, attempt: 1, digits: '9' })).toEqual({ kind: 'retry', reason: 'invalid', attempt: 2 });
    expect(decideIvr(menu, { ...base, attempt: 2, digits: '9' })).toEqual({ kind: 'fallback', reason: 'invalid', destination: { type: 'external', number: '+15550001111' } });
  });
  it('silence retries, then goes to the timeout destination (voicemail)', () => {
    expect(decideIvr(menu, { ...base, digits: null })).toEqual({ kind: 'retry', reason: 'timeout', attempt: 1 });
    expect(decideIvr(menu, { ...base, attempt: 2, digits: null })).toEqual({ kind: 'fallback', reason: 'timeout', destination: { type: 'voicemail' } });
  });
  it('"#" alone repeats the menu', () => expect(decideIvr(menu, { ...base, digits: '' })).toEqual({ kind: 'retry', reason: 'repeat', attempt: 1 }));
  it('maxRetries 0 falls back immediately', () =>
    expect(decideIvr({ ...menu, maxRetries: 0 }, { ...base, digits: '7' }).kind).toBe('fallback'));
  it('ignores junk attempt values', () => expect(decideIvr(menu, { ...base, attempt: Number.NaN, digits: '7' })).toMatchObject({ kind: 'retry', attempt: 1 }));
  it('stops menu loops at the depth cap', () => {
    expect(decideIvr(menu, { ...base, depth: IVR_MAX_DEPTH - 1, digits: '3' }).kind).toBe('route');
    expect(decideIvr(menu, { ...base, depth: IVR_MAX_DEPTH, digits: '3' })).toEqual({ kind: 'fallback', reason: 'depth', destination: { type: 'voicemail' } });
  });
  it('guards an IVR fallback destination at the depth cap', () => {
    const loop = { ...menu, invalidDestination: { type: 'ivr' as const, id: SUB } };
    expect(decideIvr(loop, { ...base, attempt: 2, depth: IVR_MAX_DEPTH, digits: '9' })).toMatchObject({ kind: 'fallback', destination: { type: 'voicemail' } });
  });
});

describe('parseDestination', () => {
  it('accepts valid shapes', () => {
    expect(parseDestination({ type: 'ivr', id: SUB })).toEqual({ type: 'ivr', id: SUB });
    expect(parseDestination({ type: 'external', number: '+15551234567' })).toEqual({ type: 'external', number: '+15551234567' });
    expect(parseDestination({ type: 'hangup' })).toEqual({ type: 'hangup' });
    expect(parseDestination({ type: 'voicemail', id: EXT })).toEqual({ type: 'voicemail', id: EXT });
  });
  it('falls back to voicemail for anything malformed', () => {
    for (const bad of [null, undefined, 'x', [], {}, { type: 'nope' }, { type: 'extension' }, { type: 'ivr', id: 'abc' }, { type: 'external', number: '555' }]) {
      expect(parseDestination(bad)).toEqual({ type: 'voicemail' });
    }
  });
});

describe('toIvrMenuConfig', () => {
  it('drops bad and duplicate digits, orders by position, clamps retries', () => {
    const c = toIvrMenuConfig(
      { max_retries: 99, timeout_destination: null, invalid_destination: { type: 'hangup' } },
      [
        { digit: '2', label: ' Support ', destination: { type: 'ring_group', id: GRP }, position: 2 },
        { digit: '1', label: 'Sales', destination: { type: 'queue', id: GRP }, position: 1 },
        { digit: '1', label: 'dupe', destination: { type: 'hangup' }, position: 3 },
        { digit: 'A', label: 'bad', destination: { type: 'hangup' }, position: 4 },
        { digit: '#', label: 'bad', destination: { type: 'hangup' }, position: 5 },
      ],
    );
    expect(c.options.map((o) => o.digit)).toEqual(['1', '2']);
    expect(c.options[1].label).toBe('Support');
    expect(c.maxRetries).toBe(5);
    expect(c.timeoutDestination).toEqual({ type: 'voicemail' });
    expect(c.invalidDestination).toEqual({ type: 'hangup' });
  });
  it('defaults retries when missing', () => expect(toIvrMenuConfig({}, []).maxRetries).toBe(2));
});

describe('prompt, messages and path', () => {
  it('speaks the option list', () =>
    expect(ivrPromptText([{ digit: '1', label: 'sales' }, { digit: '*', label: 'the operator' }, { digit: '5', label: '' }]))
      .toBe('Press 1 for sales. Press star for the operator.'));
  it('retry messages', () => {
    expect(ivrRetryMessage('invalid')).toContain('not a valid');
    expect(ivrRetryMessage('timeout', { timeout: 'Still there?' })).toBe('Still there?');
    expect(ivrRetryMessage('repeat')).toBe('');
  });
  it('tracks path depth', () => {
    expect(ivrDepth('')).toBe(0);
    expect(ivrDepth(appendIvrPath(appendIvrPath('', '1'), '3'))).toBe(2);
    expect(appendIvrPath('1', '3')).toBe('1>3');
  });
});
