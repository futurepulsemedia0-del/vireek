import { describe, expect, it } from 'vitest';
import {
  CONSENT_VERSION,
  MAX_WINBACK_MESSAGES,
  composeWinback,
  isWinbackSeq,
  reasonLine,
  unsubscribeUrl,
  winbackSkipReason,
  type WinbackContext,
} from './offboardingLogic';

const TOKEN = '3f8f1d3e-1c1a-4a54-9a40-6c0a8f6f2b11';
const msg = { seq: 1, unsubscribe_token: TOKEN };
const owner = { email: 'owner@example.com', name: 'Sam', companyName: 'Sam HVAC', status: 'suspended', subscriptionStatus: 'suspended' };
const ctx = (over: Partial<WinbackContext> = {}): WinbackContext => ({ owner, deletionRequested: false, ...over });

describe('constants', () => {
  it('caps the sequence at two messages', () => {
    expect(MAX_WINBACK_MESSAGES).toBe(2);
    expect(isWinbackSeq(1)).toBe(true);
    expect(isWinbackSeq(2)).toBe(true);
    expect(isWinbackSeq(3)).toBe(false);
    expect(isWinbackSeq('1')).toBe(false);
  });
  it('has a versioned consent string', () => {
    expect(CONSENT_VERSION).toBe('winback-v1');
  });
});

describe('winbackSkipReason', () => {
  it('sends when everything is in order', () => {
    expect(winbackSkipReason(msg, ctx())).toBeNull();
  });
  it('skips when the account no longer exists', () => {
    expect(winbackSkipReason(msg, ctx({ owner: null }))).toBe('account_gone');
  });
  it('skips when a deletion request exists (never email someone who asked for erasure)', () => {
    expect(winbackSkipReason(msg, ctx({ deletionRequested: true }))).toBe('deletion_requested');
  });
  it('skips when the account is already paying again', () => {
    expect(winbackSkipReason(msg, ctx({ owner: { ...owner, status: 'active', subscriptionStatus: 'active' } }))).toBe('already_active');
  });
  it('skips without a usable email', () => {
    expect(winbackSkipReason(msg, ctx({ owner: { ...owner, email: null } }))).toBe('no_email');
    expect(winbackSkipReason(msg, ctx({ owner: { ...owner, email: 'not-an-email' } }))).toBe('no_email');
  });
  it('rejects a bad sequence number or token', () => {
    expect(winbackSkipReason({ seq: 3, unsubscribe_token: TOKEN }, ctx())).toBe('invalid_sequence');
    expect(winbackSkipReason({ seq: 1, unsubscribe_token: 'nope' }, ctx())).toBe('invalid_token');
  });
});

const input = {
  seq: 1 as const,
  name: 'Sam',
  reason: 'too_expensive' as string | null,
  accessEndsAt: '2029-03-31T00:00:00.000Z',
  siteUrl: 'https://vireek.com/',
  unsubscribeToken: TOKEN,
  postalAddress: '1 Example Street, Springfield',
  supportEmail: 'support@example.com',
};

describe('composeWinback', () => {
  it('always carries an unsubscribe link, the sender address and the "n of 2" line', () => {
    for (const seq of [1, 2] as const) {
      const e = composeWinback({ ...input, seq });
      expect(e.text).toContain(`${unsubscribeUrl(input.siteUrl, TOKEN)}`);
      expect(e.html).toContain('Unsubscribe');
      expect(e.text).toContain(input.postalAddress);
      expect(e.text).toContain(`message ${seq} of 2`);
    }
  });
  it('builds the unsubscribe URL without double slashes', () => {
    expect(unsubscribeUrl('https://vireek.com/', TOKEN)).toBe(`https://vireek.com/winback/unsubscribe/${TOKEN}`);
  });
  it('message 2 says plainly it is the last one', () => {
    expect(composeWinback({ ...input, seq: 2 }).text).toMatch(/second and last/i);
  });
  it('never promises a discount or a deadline', () => {
    for (const reason of ['too_expensive', 'missing_features', 'switching', 'other', null]) {
      for (const seq of [1, 2] as const) {
        const t = composeWinback({ ...input, seq, reason }).text.toLowerCase();
        expect(t).not.toMatch(/%\s*off|discount|coupon|limited time|expires|act now|last chance/);
      }
    }
  });
  it('does not pitch a business that is closing', () => {
    const t = composeWinback({ ...input, reason: 'closing_business' }).text;
    expect(t).not.toContain('reactivate');
    expect(reasonLine('closing_business')).toMatch(/winding down/);
  });
  it('escapes HTML in the owner name', () => {
    const e = composeWinback({ ...input, name: '<script>alert(1)</script>' });
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
  });
  it('falls back to a neutral greeting when the name is empty', () => {
    expect(composeWinback({ ...input, name: '  ' }).text.startsWith('Hi there,')).toBe(true);
  });
  it('shows the access-end date in plain English', () => {
    expect(composeWinback(input).text).toContain('March 31, 2029');
  });
});
