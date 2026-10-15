import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) },
  },
}));

import {
  DEFAULT_FORM,
  brandCssVars,
  changedFields,
  contrastRatio,
  domainDnsRecords,
  formToPayload,
  formatSmsPreview,
  gradeContrast,
  hasErrors,
  isFormDirty,
  logoPublicUrl,
  normalizeDomain,
  normalizeHex,
  readableTextColor,
  settingsToForm,
  validateDomain,
  validateEmail,
  validateForm,
  validateLogoFile,
  type BrandSettings,
} from './branding';

describe('color helpers', () => {
  it('normalizes hex shorthand, case and missing #', () => {
    expect(normalizeHex('abc')).toBe('#AABBCC');
    expect(normalizeHex('#2563eb')).toBe('#2563EB');
    expect(normalizeHex('  2563EB ')).toBe('#2563EB');
    expect(normalizeHex('#12')).toBeNull();
    expect(normalizeHex('zzzzzz')).toBeNull();
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(gradeContrast(21)).toBe('AAA');
    expect(gradeContrast(4.6)).toBe('AA');
    expect(gradeContrast(3.2)).toBe('AA-large');
    expect(gradeContrast(2)).toBe('fail');
  });

  it('picks readable text for light and dark backgrounds', () => {
    expect(readableTextColor('#FFFF00')).toBe('#0F172A');
    expect(readableTextColor('#0B1220')).toBe('#FFFFFF');
  });

  it('falls back to defaults for invalid colors in CSS vars', () => {
    const v = brandCssVars('nope', '#FF0000');
    expect(v['--brand-primary']).toBe(DEFAULT_FORM.primary_color);
    expect(v['--brand-accent']).toBe('#FF0000');
    expect(v['--brand-on-accent']).toBe('#FFFFFF');
  });
});

describe('domain helpers', () => {
  it('normalizes pasted URLs', () => {
    expect(normalizeDomain('https://Portal.Acme.com/path?x=1')).toBe('portal.acme.com');
    expect(normalizeDomain('portal.acme.com:8080')).toBe('portal.acme.com');
    expect(normalizeDomain('portal.acme.com.')).toBe('portal.acme.com');
  });

  it('accepts empty and valid, rejects invalid and platform-owned domains', () => {
    expect(validateDomain('')).toBeNull();
    expect(validateDomain('portal.acme.com')).toBeNull();
    expect(validateDomain('acme')).not.toBeNull();
    expect(validateDomain('bad_domain.com')).not.toBeNull();
    expect(validateDomain('foo.vercel.app')).not.toBeNull();
    expect(validateDomain('x.supabase.co')).not.toBeNull();
  });

  it('builds DNS records with the token, and a placeholder before save', () => {
    const r = domainDnsRecords('portal.acme.com', 'abc123');
    expect(r[0]).toMatchObject({ type: 'TXT', host: '_vireek-verify.portal.acme.com', value: 'vireek-verify=abc123' });
    expect(r[1]).toMatchObject({ type: 'CNAME', host: 'portal.acme.com' });
    expect(domainDnsRecords('portal.acme.com', null)[0].value).toMatch(/generated/);
    expect(domainDnsRecords('', null)).toEqual([]);
  });
});

describe('validation', () => {
  it('validates emails', () => {
    expect(validateEmail('')).toBeNull();
    expect(validateEmail('a@b.co')).toBeNull();
    expect(validateEmail('nope')).not.toBeNull();
  });

  it('flags every bad field and passes the defaults', () => {
    expect(hasErrors(validateForm(DEFAULT_FORM))).toBe(false);
    const errs = validateForm({
      ...DEFAULT_FORM,
      primary_color: 'red',
      accent_color: '#12',
      email_sender_name: 'Bad <name>',
      email_reply_to: 'x',
      sms_sender_label: 'x'.repeat(31),
      custom_domain: 'nope',
    });
    expect(Object.keys(errs).sort()).toEqual(
      ['accent_color', 'custom_domain', 'email_reply_to', 'email_sender_name', 'primary_color', 'sms_sender_label'],
    );
  });

  it('validates logo files', () => {
    expect(validateLogoFile({ type: 'image/png', size: 1000 })).toBeNull();
    expect(validateLogoFile({ type: 'image/svg+xml', size: 1000 })).not.toBeNull();
    expect(validateLogoFile({ type: 'image/png', size: 3 * 1024 * 1024 })).not.toBeNull();
    expect(validateLogoFile({ type: 'image/png', size: 0 })).not.toBeNull();
  });
});

describe('form <-> row mapping', () => {
  const row: BrandSettings = {
    user_id: 'owner-1',
    logo_path: 'owner-1/logo.png',
    primary_color: '#111111',
    accent_color: '#222222',
    email_sender_name: 'Acme',
    email_reply_to: null,
    email_footer: null,
    sms_sender_label: null,
    portal_theme: 'dark',
    portal_welcome_title: null,
    portal_welcome_message: null,
    portal_show_powered_by: false,
    custom_domain: 'portal.acme.com',
    domain_status: 'pending',
    domain_verification_token: 't',
    domain_verified_at: null,
    domain_last_checked_at: null,
    domain_error: null,
    updated_at: '2027-01-01T00:00:00Z',
  };

  it('maps null columns to empty strings and defaults when no row', () => {
    const f = settingsToForm(row);
    expect(f.email_reply_to).toBe('');
    expect(f.portal_theme).toBe('dark');
    expect(settingsToForm(null)).toEqual(DEFAULT_FORM);
  });

  it('payload never contains server-controlled verification fields', () => {
    const payload = formToPayload(settingsToForm(row)) as Record<string, unknown>;
    for (const k of ['domain_status', 'domain_verification_token', 'domain_verified_at', 'user_id', 'logo_path']) {
      expect(payload).not.toHaveProperty(k);
    }
    expect(payload.email_reply_to).toBeNull();
    expect(payload.custom_domain).toBe('portal.acme.com');
  });

  it('detects dirtiness ignoring whitespace-only and case-only noise', () => {
    const base = settingsToForm(row);
    expect(isFormDirty(base, { ...base, email_footer: '   ' })).toBe(false);
    expect(isFormDirty(base, { ...base, primary_color: '#111111'.toLowerCase() })).toBe(false);
    expect(isFormDirty(base, { ...base, email_sender_name: 'Other' })).toBe(true);
    expect(changedFields({ ...base, email_sender_name: 'Other' }, base)).toEqual(['email_sender_name']);
  });
});

describe('misc', () => {
  it('formats SMS with an optional prefix', () => {
    expect(formatSmsPreview('Acme', 'On the way')).toBe('Acme: On the way');
    expect(formatSmsPreview('  ', 'On the way')).toBe('On the way');
  });

  it('resolves public logo URLs', () => {
    expect(logoPublicUrl(null)).toBeNull();
    expect(logoPublicUrl('o/logo.png')).toBe('https://cdn.test/o/logo.png');
  });
});
