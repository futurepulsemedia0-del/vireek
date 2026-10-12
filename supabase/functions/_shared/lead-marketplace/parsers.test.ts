import { describe, it, expect } from 'vitest';
import {
  buildDedupeKey,
  detectProvider,
  htmlToText,
  normalizePhone,
  parseMarketplaceEmail,
  parseMoneyToCents,
  parseWebhookPayload,
  providerFromAliasTag,
} from './parsers';
import type { ParsedLead } from './types';

// NOTE: fixtures are REPRESENTATIVE shapes, not copies of live marketplace payloads
// (those are partner-private and change). They pin the tolerant-parsing behavior.

function lead(r: ReturnType<typeof parseWebhookPayload>): ParsedLead {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.lead;
}

describe('normalizePhone / parseMoneyToCents', () => {
  it('normalizes US formats to E.164', () => {
    expect(normalizePhone('(555) 234-5678')).toBe('+15552345678');
    expect(normalizePhone('1-555-234-5678')).toBe('+15552345678');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('rejects junk', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it('parses money from strings and numbers', () => {
    expect(parseMoneyToCents('$45.00')).toBe(4500);
    expect(parseMoneyToCents('1,250.5')).toBe(125050);
    expect(parseMoneyToCents(38)).toBe(3800);
    expect(parseMoneyToCents(4500, true)).toBe(4500);
  });
  it('rejects negative, absurd, and non-numeric amounts', () => {
    expect(parseMoneyToCents('-5')).toBeNull();
    expect(parseMoneyToCents(5_000_000)).toBeNull();
    expect(parseMoneyToCents('free')).toBeNull();
  });
});

describe('detectProvider', () => {
  it('detects by sender domain', () => {
    expect(detectProvider({ from: 'Angi <leads@mail.angi.com>' })).toBe('angi');
    expect(detectProvider({ from: 'no-reply@homeadvisor.com' })).toBe('homeadvisor');
    expect(detectProvider({ from: 'noreply@thumbtack.com' })).toBe('thumbtack');
    expect(detectProvider({ from: 'x@nextdoor.com' })).toBe('nextdoor');
  });
  it('only treats google.com as LSA with LSA context', () => {
    expect(detectProvider({ from: 'a@google.com', subject: 'Your weekly digest' })).toBeNull();
    expect(detectProvider({ from: 'a@google.com', subject: 'New lead from Local Services Ads' })).toBe('google_lsa');
  });
  it('finds the original sender inside a forwarded message', () => {
    const text = '---------- Forwarded message ---------\nFrom: Thumbtack <noreply@thumbtack.com>\nSubject: x';
    expect(detectProvider({ from: 'owner@gmail.com', text })).toBe('thumbtack');
  });
  it('falls back to the alias hint, but sender evidence wins', () => {
    expect(detectProvider({ from: 'owner@gmail.com', hint: 'angi' })).toBe('angi');
    expect(detectProvider({ from: 'noreply@thumbtack.com', hint: 'angi' })).toBe('thumbtack');
    expect(detectProvider({ from: 'owner@gmail.com' })).toBeNull();
  });
  it('maps alias tags', () => {
    expect(providerFromAliasTag('LSA')).toBe('google_lsa');
    expect(providerFromAliasTag('ha')).toBe('homeadvisor');
    expect(providerFromAliasTag('unknown')).toBeNull();
    expect(providerFromAliasTag(null)).toBeNull();
  });
});

describe('parseWebhookPayload', () => {
  it('parses an Angi-style flat payload (PascalCase keys, nested address, cost string)', () => {
    const l = lead(
      parseWebhookPayload('angi', {
        ALLeadId: 'AL-991',
        FirstName: 'Jane',
        LastName: 'Doe',
        PhoneNumber: '(555) 234-5678',
        Email: 'Jane.Doe@Example.com',
        Category: 'Plumbing',
        Description: 'Water heater is leaking',
        PostalAddress: { AddressFirstLine: '12 Oak St', City: 'Austin', State: 'TX', PostalCode: '78701' },
        LeadPrice: '$42.50',
      }),
    );
    expect(l).toMatchObject({
      externalId: 'AL-991',
      name: 'Jane Doe',
      phone: '+15552345678',
      email: 'jane.doe@example.com',
      service: 'Plumbing',
      location: '12 Oak St, Austin, TX 78701',
      costCents: 4250,
    });
    expect(l.message).toContain('leaking');
  });

  it('parses a Thumbtack-style nested payload with Q&A details', () => {
    const l = lead(
      parseWebhookPayload('thumbtack', {
        negotiationID: 'n-1',
        customer: { name: 'Sam Lee', phone: '555-111-2222', email: 'sam@x.io' },
        request: {
          category: { name: 'House Cleaning' },
          description: 'Deep clean before move-in',
          location: { city: 'Denver', state: 'CO', zipCode: '80202' },
          details: [{ question: 'Bedrooms', answer: '3' }],
        },
        price: { amount: 35, currency: 'USD' },
      }),
    );
    expect(l.name).toBe('Sam Lee');
    expect(l.service).toBe('House Cleaning');
    expect(l.location).toBe('Denver, CO 80202');
    expect(l.message).toContain('Bedrooms: 3');
    expect(l.costCents).toBe(3500);
  });

  it('prefers explicit *Cents fields over dollar fields', () => {
    const l = lead(parseWebhookPayload('nextdoor', { name: 'A B', phone: '5552345678', leadCostCents: 2750, price: '$99' }));
    expect(l.costCents).toBe(2750);
  });

  it('parses a Google LSA-style payload and humanizes the category id', () => {
    const l = lead(
      parseWebhookPayload('google_lsa', {
        id: '123',
        leadType: 'PHONE_CALL',
        categoryId: 'xcat:service_area_business_plumber',
        contactDetails: { consumerName: 'Pat Kim', phoneNumber: '+15557654321' },
      }),
    );
    expect(l).toMatchObject({ externalId: '123', name: 'Pat Kim', phone: '+15557654321', service: 'Plumber' });
  });

  it('does not mistake a category.name for the customer name', () => {
    const l = lead(parseWebhookPayload('thumbtack', { category: { name: 'Plumbing' }, phone: '5552345678' }));
    expect(l.name).toBeNull();
    expect(l.service).toBe('Plumbing');
  });

  it('accepts a lead with no contact info but flags it', () => {
    const l = lead(parseWebhookPayload('google_lsa', { id: '9', categoryId: 'xcat:hvac' }));
    expect(l.warnings).toContain('no_contact_info');
  });

  it('drops absurd costs with a warning', () => {
    const l = lead(parseWebhookPayload('angi', { name: 'A B', phone: '5552345678', LeadPrice: 999999 }));
    expect(l.costCents).toBeNull();
    expect(l.warnings).toContain('cost_unparseable_or_out_of_range');
  });

  it('fails cleanly on non-objects and unknown shapes', () => {
    expect(parseWebhookPayload('angi', null).ok).toBe(false);
    expect(parseWebhookPayload('angi', 'text').ok).toBe(false);
    expect(parseWebhookPayload('angi', []).ok).toBe(false);
    const r = parseWebhookPayload('angi', { foo: 'bar', baz: { qux: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_recognized_fields');
  });

  it('is bounded: a huge payload does not blow up', () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) big[`k${i}`] = i;
    big.phone = '5552345678';
    expect(parseWebhookPayload('angi', big).ok).toBe(true);
  });
});

describe('parseMarketplaceEmail', () => {
  it('parses a labeled plain-text lead email with cost sentence', () => {
    const text = [
      'You have a new lead!',
      'Name: Maria Garcia',
      'Phone: (555) 987-6543',
      'Email: maria@example.com',
      'Service: Water Heater Repair',
      'Location: Austin, TX 78701',
      'Description: No hot water since yesterday',
      'Lead ID: HA-77',
      'You were charged $38.00 for this lead.',
      'Unsubscribe | Privacy Policy',
    ].join('\n');
    const r = parseMarketplaceEmail('homeadvisor', { from: 'noreply@homeadvisor.com', subject: 'New lead', text });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead).toMatchObject({
      name: 'Maria Garcia',
      phone: '+15559876543',
      email: 'maria@example.com',
      service: 'Water Heater Repair',
      externalId: 'HA-77',
      costCents: 3800,
    });
    expect(r.lead.location).toContain('Austin');
    expect(r.lead.warnings).toEqual([]);
  });

  it('parses an HTML table email', () => {
    const html =
      '<table><tr><td>Customer name</td><td>Tom &amp; Co</td></tr><tr><td>Phone</td><td>555-222-3333</td></tr>' +
      '<tr><td>Category</td><td>Roofing</td></tr><tr><td>Lead cost</td><td>$55</td></tr></table>';
    const r = parseMarketplaceEmail('angi', { from: 'x@angi.com', html });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead).toMatchObject({ name: 'Tom & Co', phone: '+15552223333', service: 'Roofing', costCents: 5500 });
  });

  it('handles label on one line, value on the next', () => {
    const r = parseMarketplaceEmail('nextdoor', { from: 'x@nextdoor.com', text: 'Phone\n555-444-3333\nName\nLee Park' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead).toMatchObject({ phone: '+15554443333', name: 'Lee Park' });
  });

  it('falls back to scanning the body, flagged, and ignores footer/support numbers', () => {
    const text = 'New request. Call the customer at 555-321-9876 as soon as possible.\n' + 'x'.repeat(200) + '\nUnsubscribe. Support: 877-555-0100';
    const r = parseMarketplaceEmail('thumbtack', { from: 'noreply@thumbtack.com', text });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lead.phone).toBe('+15553219876');
      expect(r.lead.warnings).toContain('phone_from_body_scan');
    }
  });

  it('never picks the marketplace or noreply address as the customer email', () => {
    const r = parseMarketplaceEmail('angi', { from: 'noreply@angi.com', text: 'Name: A B\nPhone: 555-123-4567\nContact support@angi.com or no-reply@mail.com' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.email).toBeNull();
  });

  it('takes the customer name from the subject as a last resort', () => {
    const r = parseMarketplaceEmail('thumbtack', { from: 'noreply@thumbtack.com', subject: 'Jane D. is looking for a plumber', text: 'Phone: 555-123-4567' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lead.name).toBe('Jane D.');
  });

  it('fails on empty or unrecognizable emails', () => {
    expect(parseMarketplaceEmail('angi', { from: 'x@angi.com', text: '' }).ok).toBe(false);
    const r = parseMarketplaceEmail('angi', { from: 'x@angi.com', text: 'Your monthly newsletter is here. Enjoy!' });
    expect(r.ok).toBe(false);
  });

  it('htmlToText strips scripts/styles and decodes entities', () => {
    expect(htmlToText('<style>a{}</style><p>Hi&nbsp;&amp;&#39;you</p>')).toBe("Hi &'you");
  });
});

describe('buildDedupeKey', () => {
  const base: ParsedLead = { provider: 'angi', externalId: 'E1', name: null, phone: '+15552345678', email: 'a@b.co', service: null, location: null, message: null, costCents: null, warnings: [] };
  const at = '2026-10-10T12:00:00.000Z';
  it('is contact-first so webhook + email for one lead collapse', () => {
    const fromWebhook = buildDedupeKey('angi', base, at);
    const fromEmail = buildDedupeKey('angi', { ...base, externalId: null }, at);
    expect(fromWebhook).toBe(fromEmail);
  });
  it('differs by provider and by day', () => {
    expect(buildDedupeKey('thumbtack', base, at)).not.toBe(buildDedupeKey('angi', base, at));
    expect(buildDedupeKey('angi', base, '2026-10-11T00:00:00.000Z')).not.toBe(buildDedupeKey('angi', base, at));
  });
  it('falls back to external id, then null', () => {
    expect(buildDedupeKey('angi', { ...base, phone: null, email: null }, at)).toBe('angi:x:E1');
    expect(buildDedupeKey('angi', { ...base, phone: null, email: null, externalId: null }, at)).toBeNull();
  });
});
