import { describe, expect, it } from 'vitest';
import {
  estimateWaitSeconds, isOpenNow, orderCandidates, parseDialString, pickOutboundCallerId,
  queueAnnouncement, shouldRecord, validateSchedule, type Schedule,
} from './logic';

const sched: Schedule = {
  timezone: 'America/New_York',
  weekly: { mon: [['09:00', '17:00']] },
  exceptions: [],
  include_business_holidays: true,
};
const MON_10_NY = new Date('2027-03-08T15:00:00Z'); // Monday 10:00 EST
const MON_18_NY = new Date('2027-03-08T23:00:00Z'); // Monday 18:00 EST

describe('isOpenNow', () => {
  it('fails open without a schedule', () => expect(isOpenNow(null, MON_18_NY).open).toBe(true));
  it('open inside weekly hours', () => expect(isOpenNow(sched, MON_10_NY)).toEqual({ open: true, reason: 'weekly' }));
  it('closed outside hours', () => expect(isOpenNow(sched, MON_18_NY)).toEqual({ open: false, reason: 'outside_hours' }));
  it('business holiday closes the day', () =>
    expect(isOpenNow(sched, MON_10_NY, ['2027-03-08'])).toEqual({ open: false, reason: 'holiday' }));
  it('exception beats weekly and holidays', () => {
    const s = { ...sched, exceptions: [{ date: '2027-03-08', intervals: [['10:00', '11:00']] as [string, string][] }] };
    expect(isOpenNow(s, MON_10_NY, ['2027-03-08']).open).toBe(true);
    expect(isOpenNow({ ...sched, exceptions: [{ date: '2027-03-08', closed: true }] }, MON_10_NY).reason).toBe('exception_closed');
  });
  it('supports overnight intervals', () => {
    const s = { ...sched, weekly: { mon: [['22:00', '06:00']] as [string, string][] } };
    expect(isOpenNow(s, new Date('2027-03-09T04:30:00Z')).open).toBe(true); // Mon 23:30 NY
    expect(isOpenNow(s, MON_10_NY).open).toBe(false);
  });
});

describe('validateSchedule', () => {
  it('flags bad zone, day and time', () => {
    const errs = validateSchedule({ timezone: 'Nope/Zone', weekly: { xyz: [['9:00', '25:00']] }, exceptions: [] });
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });
});

describe('orderCandidates', () => {
  const c = [
    { id: 'b', position: 2, lastCallEndedAt: '2027-03-08T10:00:00Z' },
    { id: 'a', position: 1, lastCallEndedAt: '2027-03-08T11:00:00Z' },
    { id: 'c', position: 3, lastCallEndedAt: null },
  ];
  it('simultaneous = one step', () => expect(orderCandidates('simultaneous', c)).toEqual([['a', 'b', 'c']]));
  it('sequential follows position', () => expect(orderCandidates('sequential', c)).toEqual([['a'], ['b'], ['c']]));
  it('round robin rotates by cursor', () => expect(orderCandidates('round_robin', c, 4)).toEqual([['b'], ['c'], ['a']]));
  it('longest idle: never-called first, then oldest', () =>
    expect(orderCandidates('longest_idle', c)).toEqual([['c'], ['b'], ['a']]));
  it('empty list -> no steps', () => expect(orderCandidates('sequential', [])).toEqual([]));
});

describe('queue maths', () => {
  it('estimates wait', () => {
    expect(estimateWaitSeconds(0, 200, 2)).toBe(0);
    expect(estimateWaitSeconds(4, 200, 2)).toBe(400);
    expect(estimateWaitSeconds(1, 0, 0)).toBe(240);
  });
  it('builds announcements', () => {
    expect(queueAnnouncement(1, 0, { position: true, wait: true })).toContain('next in line');
    expect(queueAnnouncement(3, 400, { position: true, wait: true })).toContain('about 7 minutes');
    expect(queueAnnouncement(3, 400, { position: false, wait: false })).toBe('');
  });
});

describe('caller ID', () => {
  const lines = [
    { id: 'l1', e164: '+15550000001', allowOutbound: true, enabled: true },
    { id: 'l2', e164: '+15550000002', allowOutbound: true, enabled: true },
    { id: 'l3', e164: '+15550000003', allowOutbound: false, enabled: true },
  ];
  it('uses the preferred line when allowed', () =>
    expect(pickOutboundCallerId({ preferredLineId: 'l2', memberships: [{ lineId: 'l1', canDialOut: true }, { lineId: 'l2', canDialOut: true }], lines })?.e164).toBe('+15550000002'));
  it('never uses a line the user is not a dial-out member of', () =>
    expect(pickOutboundCallerId({ preferredLineId: 'l2', memberships: [{ lineId: 'l1', canDialOut: true }, { lineId: 'l2', canDialOut: false }], lines })?.lineId).toBe('l1'));
  it('refuses when nothing is usable', () =>
    expect(pickOutboundCallerId({ preferredLineId: null, memberships: [{ lineId: 'l3', canDialOut: true }], lines })).toBeNull());
});

describe('dial strings & recording', () => {
  it('classifies dial strings', () => {
    expect(parseDialString('204')).toEqual({ kind: 'extension', extension: '204' });
    expect(parseDialString('(555) 123-4567')).toEqual({ kind: 'pstn', e164: '+15551234567' });
    expect(parseDialString('abc')).toBeNull();
  });
  it('decides recording', () => {
    expect(shouldRecord('inbound', 'inbound')).toBe(true);
    expect(shouldRecord('inbound', 'outbound')).toBe(false);
    expect(shouldRecord('off', 'outbound', 'all')).toBe(true);
    expect(shouldRecord('all', 'internal')).toBe(false);
  });
});
