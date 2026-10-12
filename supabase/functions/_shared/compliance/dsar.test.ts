// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildCodeEmail,
  buildReceiptEmail,
  computeDueAt,
  escapeHtml,
  generateVerificationCode,
  hashVerificationCode,
  isCodeFormat,
  validateSubmission,
} from './dsar.ts';

const valid = {
  kind: 'delete',
  email: '  Jane.Doe@Example.com ',
  fullName: 'Jane   Doe',
  relationship: 'account_holder',
  region: 'california',
  details: '',
  confirmed: true,
};

describe('validateSubmission', () => {
  it('normalizes a valid submission', () => {
    const r = validateSubmission(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.email).toBe('jane.doe@example.com');
      expect(r.value.fullName).toBe('Jane Doe');
    }
  });

  it('rejects unknown kinds, bad emails and missing confirmation', () => {
    const r = validateSubmission({ ...valid, kind: 'sell', email: 'nope', confirmed: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(['confirmed', 'email', 'kind']);
  });

  it('requires an explanation for correction requests only', () => {
    expect(validateSubmission({ ...valid, kind: 'correct', details: 'wrong' }).ok).toBe(false);
    expect(validateSubmission({ ...valid, kind: 'correct', details: 'My phone number is wrong, use 555-0100' }).ok).toBe(true);
    expect(validateSubmission({ ...valid, kind: 'access', details: '' }).ok).toBe(true);
  });

  it('falls back to region "other" and survives non-object input', () => {
    const r = validateSubmission({ ...valid, region: 'mars' });
    expect(r.ok && r.value.region).toBe('other');
    expect(validateSubmission(null).ok).toBe(false);
  });

  it('strips control characters from names', () => {
    const r = validateSubmission({ ...valid, fullName: 'Jane\r\nBcc: x@evil.com' });
    expect(r.ok && r.value.fullName.includes('\n')).toBe(false);
  });
});

describe('verification codes', () => {
  it('always yields six digits, including leading zeros', () => {
    expect(generateVerificationCode(() => 42)).toBe('000042');
    for (let i = 0; i < 200; i++) expect(isCodeFormat(generateVerificationCode())).toBe(true);
  });

  it('rejects biased values instead of wrapping them', () => {
    const seq = [0xffffffff, 7];
    expect(generateVerificationCode(() => seq.shift()!)).toBe('000007');
  });

  it('hashes deterministically and binds to request id and secret', async () => {
    const a = await hashVerificationCode('s', 'req-1', '123456');
    expect(a).toBe(await hashVerificationCode('s', 'req-1', '123456'));
    expect(a).not.toBe(await hashVerificationCode('s', 'req-2', '123456'));
    expect(a).not.toBe(await hashVerificationCode('t', 'req-1', '123456'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('dates and emails', () => {
  it('computes the due date 30 days out', () => {
    expect(computeDueAt(new Date('2027-01-01T00:00:00Z')).toISOString()).toBe('2027-01-31T00:00:00.000Z');
  });

  it('escapes user-controlled text in HTML emails', () => {
    expect(escapeHtml('<b>"x"</b>')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    const mail = buildCodeEmail({ name: '<script>alert(1)</script>', code: '123456', reference: 'DSR-1' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.subject).toContain('123456');
  });

  it('describes the right next step per outcome', () => {
    const base = { name: 'Jane', reference: 'DSR-1', kind: 'delete' as const, dueAt: new Date('2027-01-31T00:00:00Z') };
    expect(buildReceiptEmail({ ...base, outcome: 'deletion_scheduled' }).text).toContain('14-day grace period');
    expect(buildReceiptEmail({ ...base, outcome: 'deletion_blocked' }).text).toContain('legal hold');
    expect(buildReceiptEmail({ ...base, outcome: 'queued' }).subject).toContain('2027-01-31');
  });
});
