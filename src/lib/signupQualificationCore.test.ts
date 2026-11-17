import { describe, expect, it } from 'vitest';
import {
  QUALIFICATION_WINDOW_MS,
  SARAH_CARD_WINDOW_MS,
  hasAnyAnswer,
  sanitizeAnswers,
  shouldPromptQualification,
} from './signupQualificationCore';

const NOW = Date.parse('2029-03-10T12:00:00Z');
const base = { role: 'owner', onboardingCompleted: false, createdAt: '2029-03-10T11:00:00Z', now: NOW };

describe('sanitizeAnswers', () => {
  it('keeps only known questions and known option values', () => {
    expect(sanitizeAnswers({ trade: 'hvac', team_size: 'huge', evil: 'x', call_handling: 'none' })).toEqual({
      trade: 'hvac',
      call_handling: 'none',
    });
  });
  it('rejects non-string and non-object input', () => {
    expect(sanitizeAnswers(null)).toEqual({});
    expect(sanitizeAnswers({ trade: 5 })).toEqual({});
  });
  it('hasAnyAnswer ignores invalid values', () => {
    expect(hasAnyAnswer({})).toBe(false);
    expect(hasAnyAnswer({ trade: 'nope' })).toBe(false);
    expect(hasAnyAnswer({ team_size: 'solo' })).toBe(true);
  });
});

describe('shouldPromptQualification', () => {
  it('prompts a fresh un-onboarded owner', () => {
    expect(shouldPromptQualification(base)).toBe(true);
  });
  it('never prompts non-owners', () => {
    expect(shouldPromptQualification({ ...base, role: 'member' })).toBe(false);
    expect(shouldPromptQualification({ ...base, role: 'admin' })).toBe(false);
  });
  it('never prompts onboarded accounts', () => {
    expect(shouldPromptQualification({ ...base, onboardingCompleted: true })).toBe(false);
  });
  it('never prompts old accounts', () => {
    const old = new Date(NOW - QUALIFICATION_WINDOW_MS - 1000).toISOString();
    expect(shouldPromptQualification({ ...base, createdAt: old })).toBe(false);
  });
  it('honours a custom window (Sarah card)', () => {
    const d20 = new Date(NOW - 20 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldPromptQualification({ ...base, createdAt: d20 })).toBe(false);
    expect(shouldPromptQualification({ ...base, createdAt: d20, windowMs: SARAH_CARD_WINDOW_MS })).toBe(true);
  });
  it('fails closed on missing or invalid dates', () => {
    expect(shouldPromptQualification({ ...base, createdAt: null })).toBe(false);
    expect(shouldPromptQualification({ ...base, createdAt: 'garbage' })).toBe(false);
  });
});
