import { describe, expect, it } from 'vitest';
import { DARK, LIGHT, contrastRatio, esc, renderEmail, resolveLocale, safeUrl } from './layout';
import { scrubForLog, toAbsoluteUrl, toEmail, toPush, toSms, toToast } from './notification';
import { buildSecurityNotification, type SecurityEvent } from './securityTemplates';

const SITE = 'https://app.vireek.com';
const base = { subject: 'S', preheader: 'Pre', title: 'T', body: 'Body', siteUrl: SITE };
const EVENTS: SecurityEvent[] = ['new_sign_in', 'password_changed', 'email_changed', 'mfa_enrolled', 'mfa_disabled', 'recovery_codes_regenerated', 'api_key_created', 'api_key_revoked'];
const ctx = { whenUtc: new Date('2027-04-02T10:15:30Z'), device: 'Chrome on Windows', location: 'Berlin, DE', ipMasked: '203.0.113.0', keyName: 'Zapier', newEmailMasked: 'j***@example.com' };

describe('renderEmail', () => {
  it('produces a table-based, Outlook-safe document with preheader, dark mode and plain text', () => {
    const m = renderEmail({ ...base, action: { label: 'Go', url: `${SITE}/x` }, facts: [['When', 'now']] });
    expect(m.html).toContain('<!--[if mso]>');
    expect(m.html).toContain('prefers-color-scheme:dark');
    expect(m.html).toContain('name="color-scheme"');
    expect(m.html).toContain('mso-hide:all');
    expect(m.html).toContain('href="https://app.vireek.com/x"');
    expect(m.text).toContain('Go: https://app.vireek.com/x');
    expect(m.text).toContain('When: now');
    expect(m.html).not.toMatch(/<img/i);
  });

  it('escapes every dynamic value and neutralises unsafe URLs', () => {
    const m = renderEmail({ ...base, title: '<script>alert(1)</script>', body: 'a & b', facts: [['<b>k</b>', '"v"']], action: { label: '<i>x</i>', url: 'javascript:alert(1)' } });
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<b>k</b>');
    expect(m.html).not.toContain('javascript:');
    expect(m.html).toContain('a &amp; b');
    expect(esc(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
    expect(safeUrl('data:text/html,x')).toBe('#');
    expect(safeUrl('mailto:a@b.co')).toBe('mailto:a@b.co');
  });

  it('only shows the preferences link when one is provided', () => {
    expect(renderEmail(base).html).not.toContain('Notification preferences');
    expect(renderEmail({ ...base, preferencesUrl: `${SITE}/p` }).html).toContain('href="https://app.vireek.com/p"');
  });

  it('meets WCAG AA (4.5:1) for text, muted text, accent eyebrow and button label in light and dark', () => {
    for (const [name, set] of [['light', LIGHT], ['dark', DARK]] as const) {
      for (const [sev, p] of Object.entries(set)) {
        const tag = `${name}/${sev}`;
        expect(contrastRatio(p.text, p.card), `${tag} text`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(p.muted, p.card), `${tag} muted/card`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(p.muted, p.page), `${tag} muted/page`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(p.accent, p.card), `${tag} eyebrow`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(p.onAccent, p.accent), `${tag} button`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('locale handling', () => {
  it('falls back region -> language -> English and never throws', () => {
    expect(resolveLocale('fa-IR')).toBe('fa');
    expect(resolveLocale('fa_ir')).toBe('fa');
    expect(resolveLocale('de-DE')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('')).toBe('en');
  });
  it('sets lang/dir and localized chrome for RTL, and English chrome for untranslated locales', () => {
    const fa = renderEmail({ ...base, locale: 'fa-IR', severity: 'critical' });
    expect(fa.dir).toBe('rtl');
    expect(fa.html).toContain('lang="fa" dir="rtl"');
    expect(fa.html).toContain('هشدار امنیتی');
    const de = renderEmail({ ...base, locale: 'de' });
    expect(de.lang).toBe('en');
    expect(de.dir).toBe('ltr');
    expect(de.html).toContain('You are receiving this');
  });
});

describe('unified notification adapters', () => {
  const n = buildSecurityNotification('password_changed', ctx);
  it('derives toast, push, sms and email from one object with the same deep link and severity', () => {
    expect(toToast(n).tone).toBe('error');
    expect(toPush(n, SITE).data).toEqual({ url: `${SITE}/dashboard/settings/sessions`, severity: 'high' });
    const sms = toSms(n, SITE);
    expect(sms.length).toBeLessThanOrEqual(160);
    expect(sms).toContain(`${SITE}/dashboard/settings/sessions`);
    expect(toEmail(n, { siteUrl: SITE }).html).toContain(`href="${SITE}/dashboard/settings/sessions"`);
  });
  it('rejects protocol-relative and script URLs when resolving deep links', () => {
    expect(toAbsoluteUrl('//evil.com', SITE)).toBe('#');
    expect(toAbsoluteUrl('javascript:x', SITE)).toBe('#');
    expect(toAbsoluteUrl('/a', `${SITE}/`)).toBe(`${SITE}/a`);
  });
});

describe('security notifications', () => {
  it.each(EVENTS)('%s states what happened, when, and what to do', (ev) => {
    const n = buildSecurityNotification(ev, { ...ctx, reason: 'a new device' });
    expect(n.title.length).toBeGreaterThan(5);
    expect(n.facts?.some(([k]) => k === 'When')).toBe(true);
    expect(n.facts?.find(([k]) => k === 'When')?.[1]).toBe('2027-04-02 10:15 UTC');
    expect(n.action?.url.startsWith('/dashboard/')).toBe(true);
    expect(n.body).not.toMatch(/\{[a-zA-Z]+\}/);
    const m = toEmail(n, { siteUrl: SITE });
    expect(m.text).toContain('2027-04-02 10:15 UTC');
  });
  it('offers an "it wasn’t me" path for every alarming event and names the API key without its secret', () => {
    for (const ev of ['new_sign_in', 'password_changed', 'email_changed', 'mfa_disabled', 'api_key_created'] as const) {
      expect(buildSecurityNotification(ev, ctx).notYou?.action.url).toBe('/dashboard/settings/security');
    }
    expect(buildSecurityNotification('api_key_created', ctx).body).toContain('“Zapier”');
  });
  it('omits optional facts when unknown instead of printing "undefined"', () => {
    const n = buildSecurityNotification('mfa_enrolled', { whenUtc: ctx.whenUtc });
    expect(n.facts).toEqual([['When', '2027-04-02 10:15 UTC']]);
  });
  it('escapes attacker-controlled device labels', () => {
    const n = buildSecurityNotification('new_sign_in', { ...ctx, device: '<img src=x onerror=alert(1)>' });
    expect(toEmail(n, { siteUrl: SITE }).html).not.toContain('<img src=x');
  });
});

describe('scrubForLog', () => {
  it('masks emails, JWTs, provider secrets, hex blobs and phone numbers', () => {
    const s = scrubForLog('to jane@example.com tok eyJhbGciOi.eyJzdWIiOiIxIn0.sig key sk_live_abcdef123456 hash 0123456789abcdef0123456789abcdef call +1 (555) 123-4567');
    expect(s).not.toMatch(/jane@|eyJ|sk_live|0123456789abcdef|555/);
    expect(s).toContain('[email]');
    expect(s).toContain('[jwt]');
    expect(s).toContain('[secret]');
    expect(s).toContain('[hex]');
    expect(s).toContain('[phone]');
  });
});
