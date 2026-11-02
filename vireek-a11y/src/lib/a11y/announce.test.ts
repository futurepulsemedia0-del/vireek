import { describe, expect, it } from 'vitest';
import { announce, getAnnouncement, subscribeAnnouncement } from './announce';

describe('announce', () => {
  it('notifies subscribers and makes identical consecutive messages distinct', () => {
    let calls = 0;
    const off = subscribeAnnouncement(() => { calls += 1; });
    announce('Saved');
    const a = getAnnouncement();
    announce('Saved');
    const b = getAnnouncement();
    expect(calls).toBe(2);
    expect(a === b).toBe(false);
    off();
    announce('x');
    expect(calls).toBe(2);
  });
});
