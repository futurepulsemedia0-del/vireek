import { describe, expect, it } from 'vitest';
import { emailProblem, isRateLimited, passwordProblem, PASSWORD_MAX, PASSWORD_MIN } from './signupValidation';

describe('emailProblem', () => {
  it('accepts normal and padded addresses', () => {
    expect(emailProblem('jane@company.com')).toBeNull();
    expect(emailProblem('  jane+tag@sub.company.co.uk  ')).toBeNull();
  });
  it('flags empty and whitespace-only input as required', () => {
    expect(emailProblem('')).toBe('required');
    expect(emailProblem('   ')).toBe('required');
  });
  it('flags malformed addresses', () => {
    for (const bad of ['jane', 'jane@', '@company.com', 'jane@company', 'ja ne@company.com', 'a@b@c.com']) {
      expect(emailProblem(bad)).toBe('invalid');
    }
  });
});

describe('passwordProblem (NIST: length over composition)', () => {
  it('rejects only by length', () => {
    expect(passwordProblem('1234567')).toBe('tooShort');
    expect(passwordProblem('a'.repeat(PASSWORD_MAX + 1))).toBe('tooLong');
  });
  it('accepts all-lowercase passphrases with no digit or symbol', () => {
    expect(passwordProblem('correct horse battery')).toBeNull();
    expect(passwordProblem('a'.repeat(PASSWORD_MIN))).toBeNull();
    expect(passwordProblem('a'.repeat(PASSWORD_MAX))).toBeNull();
  });
  it('accepts spaces and unicode (paste from password managers / Persian passphrases)', () => {
    expect(passwordProblem('گذرواژه طولانی من')).toBeNull();
  });
});

describe('isRateLimited', () => {
  it('detects status 429 and message variants', () => {
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited({ message: 'email rate limit exceeded' })).toBe(true);
    expect(isRateLimited({ message: 'Too many requests' })).toBe(true);
  });
  it('ignores other errors and non-objects', () => {
    expect(isRateLimited({ status: 400, message: 'Invalid login' })).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited('x')).toBe(false);
  });
});
