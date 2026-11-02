import { describe, expect, it } from 'vitest';
import { parseReviewState } from './reviewService';

describe('parseReviewState', () => {
  it('starts fresh with no data', () => {
    expect(parseReviewState(null, 5)).toEqual({ installedAt: 5, lastPromptedAt: null, promptCount: 0, completedJobs: 0, lastErrorAt: null });
  });
  it('survives corrupt JSON', () => expect(parseReviewState('{nope', 9).installedAt).toBe(9));
  it('rejects negative or non-numeric counters', () => {
    const s = parseReviewState(JSON.stringify({ installedAt: 1, promptCount: -4, completedJobs: 'x' }), 9);
    expect(s.promptCount).toBe(0);
    expect(s.completedJobs).toBe(0);
    expect(s.installedAt).toBe(1);
  });
});
