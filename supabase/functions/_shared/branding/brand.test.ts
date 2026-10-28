import { describe, expect, it } from 'vitest';
import { applyFooter, brandedFrom, composeEmailBrand } from './brand';

const email = { sender_name: null, reply_to_email: null, sender_local_part: 'billing', sender_domain: 'mail.acme.com', domain_status: 'verified' };
const PLATFORM = 'Vireek <onboarding@resend.dev>';

describe('email brand', () => {
  it('entitled + badge off + verified domain: no Vireek in From, footer or reply-to', () => {
    const b = composeEmailBrand({
      companyName: 'Acme HVAC',
      plan: 'business',
      brand: { portal_show_powered_by: false, email_footer: 'Acme HVAC · 555-0100', email_reply_to: 'help@acme.com' },
      email,
    });
    const from = brandedFrom(b, PLATFORM);
    const out = applyFooter('<p>Hi</p>', 'Hi', b);
    expect(from).toBe('Acme HVAC <billing@mail.acme.com>');
    expect(b.replyTo).toBe('help@acme.com');
    expect(JSON.stringify([b, from, out])).not.toMatch(/vireek/i);
  });

  it('not entitled (e.g. downgraded) → attribution is appended', () => {
    const b = composeEmailBrand({ companyName: 'Acme', plan: 'starter', brand: { portal_show_powered_by: false }, email: null });
    expect(b.showVireek).toBe(true);
    expect(applyFooter('<p>x</p>', 'x', b).text).toContain('Sent via Vireek');
  });

  it('no company name and badge off falls back to a neutral display name, never the platform name', () => {
    const b = composeEmailBrand({ companyName: null, plan: 'enterprise', brand: { portal_show_powered_by: false }, email: null });
    expect(brandedFrom(b, PLATFORM)).toBe('Customer service <onboarding@resend.dev>');
  });

  it('an unverified sender domain is never used in From', () => {
    const b = composeEmailBrand({ companyName: 'Acme', plan: 'business', brand: { portal_show_powered_by: false }, email: { ...email, domain_status: 'pending' } });
    expect(b.fromAddress).toBeNull();
  });
});
