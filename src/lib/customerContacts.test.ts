import { describe, expect, it } from 'vitest';
import {
  bestChannel,
  contactsForPurpose,
  describeContactError,
  draftFromContact,
  emptyDraft,
  formatPhone,
  initials,
  normalizeContactRow,
  normalizeEmail,
  normalizePhone,
  roleCoverage,
  sortContacts,
  validateDraft,
  type CustomerContact,
} from './customerContacts';

const make = (over: Partial<CustomerContact> & { id: string }): CustomerContact => ({
  customerId: 'cust-1',
  fullName: 'Person',
  jobTitle: null,
  email: null,
  phone: null,
  roles: [],
  isPrimary: false,
  siteLabel: null,
  preferredChannel: 'any',
  language: null,
  portalAccess: false,
  notes: null,
  createdAt: '2027-12-01T00:00:00Z',
  ...over,
});

const owner = make({ id: 'a', fullName: 'Dana Owner', email: 'dana@acme.com', phone: '512-555-0100', roles: ['billing'], isPrimary: true });
const site = make({ id: 'b', fullName: 'Sam Site', phone: '(512) 555-0111', roles: ['site'], createdAt: '2027-12-02T00:00:00Z' });
const tenant = make({ id: 'c', fullName: 'Tia Tenant', email: 'tia@mail.com', roles: ['tenant'], siteLabel: 'Unit 4B', createdAt: '2027-12-03T00:00:00Z' });
const emergency = make({ id: 'd', fullName: 'Eli Emergency', phone: '512-555-0199', roles: ['emergency'], createdAt: '2027-12-04T00:00:00Z' });
const all = [tenant, emergency, site, owner];

describe('normalizePhone / normalizeEmail', () => {
  it('mirrors the SQL helper', () => {
    expect(normalizePhone('(512) 555-0123')).toBe('+15125550123');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('15125550123')).toBe('+15125550123');
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it('lowercases and trims email', () => {
    expect(normalizeEmail('  Dana@Acme.COM ')).toBe('dana@acme.com');
    expect(normalizeEmail('   ')).toBeNull();
  });
  it('formats US numbers for display only', () => {
    expect(formatPhone('5125550123')).toBe('(512) 555-0123');
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhone(null)).toBe('');
  });
  it('builds initials', () => {
    expect(initials('Dana Marie Owner')).toBe('DO');
    expect(initials('madonna')).toBe('M');
    expect(initials('   ')).toBe('?');
  });
});

describe('validateDraft', () => {
  const good = { ...emptyDraft(), fullName: 'New Person', email: 'new@acme.com', roles: ['site' as const] };

  it('accepts a minimal valid draft and normalises it', () => {
    const r = validateDraft({ ...good, email: ' New@Acme.com ', fullName: '  New Person ' }, all);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.email).toBe('new@acme.com');
      expect(r.value.fullName).toBe('New Person');
    }
  });

  it('requires a name and at least one way to reach the person', () => {
    const r = validateDraft(emptyDraft(), all);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.fullName).toBeTruthy();
      expect(r.errors.contact).toBeTruthy();
    }
  });

  it('rejects malformed email and phone', () => {
    const r = validateDraft({ ...good, email: 'nope', phone: '12' }, all);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.email).toBeTruthy();
      expect(r.errors.phone).toBeTruthy();
    }
  });

  it('detects duplicates among other contacts but not the one being edited', () => {
    const dupEmail = validateDraft({ ...good, email: 'DANA@acme.com' }, all);
    expect(dupEmail.ok).toBe(false);
    const dupPhone = validateDraft({ ...good, email: '', phone: '+1 512 555 0111' }, all);
    expect(dupPhone.ok).toBe(false);
    const editingSelf = validateDraft({ ...good, email: 'dana@acme.com' }, all, 'a');
    expect(editingSelf.ok).toBe(true);
  });

  it('enforces length limits', () => {
    const r = validateDraft({ ...good, fullName: 'x'.repeat(121), notes: 'n'.repeat(1001) }, all);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.fullName).toBeTruthy();
      expect(r.errors.notes).toBeTruthy();
    }
  });

  it('round-trips a contact through a draft', () => {
    const r = validateDraft(draftFromContact(tenant), all, tenant.id);
    expect(r.ok).toBe(true);
  });
});

describe('normalizeContactRow', () => {
  it('parses a valid row and drops unknown roles', () => {
    const c = normalizeContactRow({
      id: 'x', customer_id: 'c', full_name: 'Ann', email: 'a@b.co', phone: '', roles: ['billing', 'wizard', 'site'],
      is_primary: true, preferred_channel: 'carrier-pigeon', language: 'xx', portal_access: true, created_at: '2027-12-01',
    });
    expect(c).not.toBeNull();
    expect(c?.roles).toEqual(['billing', 'site']);
    expect(c?.phone).toBeNull();
    expect(c?.preferredChannel).toBe('any');
    expect(c?.language).toBeNull();
    expect(c?.isPrimary).toBe(true);
  });
  it('returns null for unusable rows', () => {
    expect(normalizeContactRow(null)).toBeNull();
    expect(normalizeContactRow({ id: 'x' })).toBeNull();
    expect(normalizeContactRow({ id: 'x', customer_id: 'c', full_name: '   ' })).toBeNull();
  });
});

describe('sortContacts', () => {
  it('puts the primary first, then oldest first', () => {
    expect(sortContacts(all).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('contactsForPurpose (mirrors customer_contact_recipients)', () => {
  it('invoice → billing contacts with an email', () => {
    expect(contactsForPurpose(all, 'invoice').map((r) => r.contactId)).toEqual(['a']);
  });
  it('service → site + tenant contacts that are reachable', () => {
    expect(contactsForPurpose(all, 'service').map((r) => r.contactId)).toEqual(['b', 'c']);
  });
  it('emergency → emergency contacts', () => {
    expect(contactsForPurpose(all, 'emergency').map((r) => r.contactId)).toEqual(['d']);
  });
  it('portal → only contacts with portal access and an email', () => {
    expect(contactsForPurpose(all, 'portal').map((r) => r.contactId)).toEqual(['a']);
    expect(contactsForPurpose(all, 'portal')[0].isFallback).toBe(true);
    const withPortal = [...all.filter((c) => c.id !== 'c'), { ...tenant, portalAccess: true }];
    expect(contactsForPurpose(withPortal, 'portal').map((r) => r.contactId)).toEqual(['c']);
  });
  it('general → the primary contact', () => {
    expect(contactsForPurpose(all, 'general').map((r) => r.contactId)).toEqual(['a']);
  });
  it('falls back to the primary, flagged as a fallback', () => {
    const r = contactsForPurpose([owner], 'emergency');
    expect(r).toHaveLength(1);
    expect(r[0].isFallback).toBe(true);
    expect(r[0].contactId).toBe('a');
  });
  it('invoice never falls back to an email-less primary; uses the customer record instead', () => {
    const phoneOnlyPrimary = make({ id: 'p', fullName: 'Phone Only', phone: '5125550101', roles: ['billing'], isPrimary: true });
    expect(contactsForPurpose([phoneOnlyPrimary], 'invoice')).toHaveLength(0);
    const r = contactsForPurpose([phoneOnlyPrimary], 'invoice', { name: 'Acme', email: 'ap@acme.com', phone: null });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ contactId: null, email: 'ap@acme.com', isFallback: true });
  });
  it('returns nothing when nobody is reachable', () => {
    expect(contactsForPurpose([], 'service')).toEqual([]);
    expect(contactsForPurpose([], 'service', { name: 'X', email: null, phone: null })).toEqual([]);
  });
});

describe('roleCoverage', () => {
  it('reports which roles are covered', () => {
    const cov = roleCoverage([owner, site]);
    expect(cov.find((c) => c.role === 'billing')?.covered).toBe(true);
    expect(cov.find((c) => c.role === 'site')?.count).toBe(1);
    expect(cov.find((c) => c.role === 'emergency')?.covered).toBe(false);
    expect(cov.find((c) => c.role === 'tenant')?.covered).toBe(false);
  });
});

describe('bestChannel', () => {
  it('respects the preference when possible', () => {
    expect(bestChannel({ email: 'a@b.co', phone: '5125550100', preferredChannel: 'email' })).toBe('email');
    expect(bestChannel({ email: 'a@b.co', phone: '5125550100', preferredChannel: 'phone' })).toBe('phone');
  });
  it('falls back to whatever exists', () => {
    expect(bestChannel({ email: 'a@b.co', phone: null, preferredChannel: 'sms' })).toBe('email');
    expect(bestChannel({ email: null, phone: '5125550100', preferredChannel: 'email' })).toBe('sms');
    expect(bestChannel({ email: null, phone: null, preferredChannel: 'any' })).toBeNull();
  });
});

describe('describeContactError', () => {
  it('maps common database errors', () => {
    expect(describeContactError({ code: '23505', message: 'uq_customer_contacts_phone' })).toMatch(/phone/);
    expect(describeContactError({ code: '23505', message: 'uq_customer_contacts_email' })).toMatch(/email/);
    expect(describeContactError({ code: '42501', message: 'x' })).toMatch(/permission/);
    expect(describeContactError(null)).toMatch(/Something went wrong/);
  });
});
