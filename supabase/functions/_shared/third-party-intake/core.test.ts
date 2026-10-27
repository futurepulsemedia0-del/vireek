import { describe, it, expect } from 'vitest';
import {
  buildDedupeKey,
  matchPayer,
  normalizePriority,
  parseApiPayload,
  parseDue,
  parseEmail,
  parseMoneyToCents,
  senderDomain,
} from './core.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');

describe('parseMoneyToCents', () => {
  it('reads dollars from numbers and messy strings', () => {
    expect(parseMoneyToCents(500)).toBe(50000);
    expect(parseMoneyToCents('$1,250.50')).toBe(125050);
    expect(parseMoneyToCents('NTE $75')).toBe(7500);
  });
  it('rejects junk, negatives and integer overflow', () => {
    expect(parseMoneyToCents('n/a')).toBeNull();
    expect(parseMoneyToCents(-5)).toBeNull();
    expect(parseMoneyToCents('99999999')).toBeNull();
    expect(parseMoneyToCents(undefined)).toBeNull();
  });
});

describe('normalizePriority / parseDue', () => {
  it('maps common words', () => {
    expect(normalizePriority('EMERGENCY - no heat')).toBe('emergency');
    expect(normalizePriority('High')).toBe('urgent');
    expect(normalizePriority('Routine')).toBe('standard');
    expect(normalizePriority('???')).toBeNull();
  });
  it('accepts only future deadlines within a year', () => {
    expect(parseDue('2026-10-27T12:00:00Z', NOW)).toBe('2026-10-27T12:00:00.000Z');
    expect(parseDue('2026-10-25T12:00:00Z', NOW)).toBeNull();
    expect(parseDue('2030-01-01T00:00:00Z', NOW)).toBeNull();
    expect(parseDue('soon', NOW)).toBeNull();
  });
});

describe('parseApiPayload', () => {
  it('normalises key styles and nested customer objects', () => {
    const r = parseApiPayload({
      claimNumber: 'CLM-1001',
      Summary: 'Refrigerator not cooling',
      priority: 'urgent',
      customer: { name: 'Ana Lopez', phone: '(555) 010-2030', email: 'ANA@Example.com' },
      address: { street: '12 Oak St', city: 'Austin', state: 'TX', zip: '78701' },
      nte: '$450',
      policy_number: 'HW-9',
      due_at: '2026-10-28T09:00:00Z',
    }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intake.externalRef).toBe('CLM-1001');
    expect(r.intake.customerName).toBe('Ana Lopez');
    expect(r.intake.customerEmail).toBe('ana@example.com');
    expect(r.intake.serviceAddress).toBe('12 Oak St, Austin, TX, 78701');
    expect(r.intake.nteCents).toBe(45000);
    expect(r.intake.preAuthorized).toBe(false);
    expect(r.intake.priority).toBe('urgent');
    expect(r.intake.dueAt).toBe('2026-10-28T09:00:00.000Z');
    expect(r.intake.reviewReasons).toHaveLength(0);
  });

  it('treats an explicit authorized amount as pre-authorization', () => {
    const r = parseApiPayload({ title: 'AC repair', authorized_amount: 300 }, NOW);
    expect(r.ok && r.intake.preAuthorized).toBe(true);
    expect(r.ok && r.intake.authorizedCents).toBe(30000);
    expect(r.ok && r.intake.nteCents).toBe(30000);
  });

  it('flags missing address / contact instead of rejecting', () => {
    const r = parseApiPayload({ description: 'Leak under sink' }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intake.title).toBe('Leak under sink');
      expect(r.intake.reviewReasons).toHaveLength(2);
    }
  });

  it('rejects empty and non-object bodies', () => {
    expect(parseApiPayload({ priority: 'urgent' }, NOW).ok).toBe(false);
    expect(parseApiPayload(null, NOW).ok).toBe(false);
    expect(parseApiPayload([1, 2], NOW).ok).toBe(false);
  });
});

describe('parseEmail', () => {
  const text = [
    'New service request',
    'Claim #: WC-554821',
    'Policyholder: Sam Rivera',
    'Phone: 512-555-0147',
    'Service Address: 9 Pine Ave, Dallas TX',
    'Problem: Water heater leaking',
    'Priority: Emergency',
    'NTE: $350.00',
  ].join('\n');

  it('extracts labelled fields', () => {
    const r = parseEmail({ from: 'Dispatch <ops@warrantyco.com>', subject: 'Fwd: Service request WC-554821', text, html: null }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intake.externalRef).toBe('WC-554821');
    expect(r.intake.customerName).toBe('Sam Rivera');
    expect(r.intake.customerPhone).toBe('512-555-0147');
    expect(r.intake.serviceAddress).toBe('9 Pine Ave, Dallas TX');
    expect(r.intake.priority).toBe('emergency');
    expect(r.intake.nteCents).toBe(35000);
    expect(r.intake.title).toBe('Service request WC-554821');
    expect(r.intake.reviewReasons).toHaveLength(0);
  });

  it('never drops an unreadable email: keeps it with review reasons', () => {
    const r = parseEmail({ from: 'x@y.com', subject: 'Please call me', text: 'hi there, can you help my mom?', html: null }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intake.title).toBe('Please call me');
      expect(r.intake.reviewReasons[0]).toMatch(/structured fields/);
    }
  });

  it('reads HTML table emails', () => {
    const html = '<table><tr><td>Claim #</td><td>A-77</td></tr><tr><td>Address</td><td>1 Main St</td></tr><tr><td>Phone</td><td>555-123-4567</td></tr></table>';
    const r = parseEmail({ from: 'a@b.com', subject: 'Job', text: null, html }, NOW);
    expect(r.ok && r.intake.externalRef).toBe('A-77');
    expect(r.ok && r.intake.serviceAddress).toBe('1 Main St');
  });
});

describe('matchPayer / senderDomain', () => {
  const payers = [
    { id: 'a', email_tag: 'chubb', sender_domains: ['chubb.com'] },
    { id: 'b', email_tag: null, sender_domains: ['warrantyco.com'] },
    { id: 'c', email_tag: null, sender_domains: ['shared.com'] },
    { id: 'd', email_tag: null, sender_domains: ['shared.com'] },
  ];
  it('parses sender domains', () => {
    expect(senderDomain('Ops Team <Ops@WarrantyCo.com>')).toBe('warrantyco.com');
    expect(senderDomain('nope')).toBeNull();
  });
  it('prefers the secret tag, then a unique domain', () => {
    expect(matchPayer(payers, 'chubb', null)?.via).toBe('tag');
    expect(matchPayer(payers, null, 'mail.warrantyco.com')).toEqual({ payer: payers[1], via: 'domain' });
  });
  it('refuses ambiguous or unknown domains', () => {
    expect(matchPayer(payers, null, 'shared.com')).toBeNull();
    expect(matchPayer(payers, 'zzz', 'other.com')).toBeNull();
  });
});

describe('buildDedupeKey', () => {
  it('is stable per partner + reference, content-hashed otherwise', async () => {
    const a = await buildDedupeKey('p1', { externalRef: ' CLM 1 ' }, 'x');
    const b = await buildDedupeKey('p1', { externalRef: 'clm1' }, 'y');
    expect(a).toBe(b);
    expect(await buildDedupeKey('p2', { externalRef: 'clm1' }, 'x')).not.toBe(a);
    const h1 = await buildDedupeKey('p1', { externalRef: null }, 'same body');
    expect(h1).toBe(await buildDedupeKey('p1', { externalRef: null }, 'same body'));
    expect(h1).not.toBe(await buildDedupeKey('p1', { externalRef: null }, 'other body'));
  });
});
