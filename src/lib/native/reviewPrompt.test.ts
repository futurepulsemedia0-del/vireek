import { describe, expect, it } from 'vitest';
import { shouldAskForReview, type ReviewState } from './reviewPrompt';

const DAY = 86_400_000;
const now = 200 * DAY;
const st: ReviewState = { installedAt: 0, lastPromptedAt: null, promptCount: 0, completedJobs: 6, lastErrorAt: null };

describe('shouldAskForReview', () => {
  it('asks after a happy streak', () => expect(shouldAskForReview(st, now)).toBe(true));
  it('waits for enough completed jobs', () => expect(shouldAskForReview({ ...st, completedJobs: 4 }, now)).toBe(false));
  it('respects the cooldown', () => expect(shouldAskForReview({ ...st, lastPromptedAt: now - 10 * DAY }, now)).toBe(false));
  it('stays quiet after a recent error', () => expect(shouldAskForReview({ ...st, lastErrorAt: now - DAY }, now)).toBe(false));
  it('caps the total number of prompts', () => expect(shouldAskForReview({ ...st, promptCount: 3 }, now)).toBe(false));
});
