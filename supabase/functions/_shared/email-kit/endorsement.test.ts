import { afterEach, describe, expect, it } from 'vitest';
import { renderEmail } from './layout';
import { platformEndorsementLine } from './endorsement';
import { applyFooter, composeEmailBrand } from '../branding/brand';

const base = { subject: 'S', preheader: 'Pre', title: 'T', body: 'Body', siteUrl: 'https://app.vireek.com' };
const g = globalThis as unknown as { Deno?: unknown };
const original = g.Deno;
afterEach(() => { g.Deno = original; });

function stubDeno(vars: Record<string, string>) {
  g.Deno = { env: { get: (k: string) => vars[k] } };
}

describe('system email endorsement', () => {
  it('flag OFF (no env): output is byte-identical to the explicit-null render', () => {
    const implicit = renderEmail(base);
    const explicit = renderEmail({ ...base, endorsementLine: null });
    expect(implicit).toEqual(explicit);
    expect(implicit.html).not.toMatch(/Part of/);
    expect(implicit.text).not.toMatch(/Part of/);
  });
  it('flag ON via env: adds the line to the footer (html + text) only', () => {
    stubDeno({ PLATFORM_ENDORSEMENT_ENABLED: 'true', PLATFORM_PARENT_NAME: 'Acme Group' });
    expect(platformEndorsementLine()).toBe('Part of Acme Group');
    const m = renderEmail(base);
    expect(m.html).toContain('Part of Acme Group');
    expect(m.text).toContain('Part of Acme Group');
    // appended after the help line, i.e. inside the footer
    expect(m.html.indexOf('Part of Acme Group')).toBeGreaterThan(m.html.indexOf('Need help?'));
  });
  it('accepts the VITE_-prefixed variable names too', () => {
    stubDeno({ VITE_PLATFORM_ENDORSEMENT_ENABLED: '1', VITE_PLATFORM_PARENT_NAME: 'Acme' });
    expect(platformEndorsementLine()).toBe('Part of Acme');
  });
  it('flag ON + parent unset: nothing renders, no errors', () => {
    stubDeno({ PLATFORM_ENDORSEMENT_ENABLED: 'true' });
    expect(platformEndorsementLine()).toBeNull();
    expect(renderEmail(base).html).not.toMatch(/Part of/);
  });
  it('escapes the line (defence in depth)', () => {
    const m = renderEmail({ ...base, endorsementLine: 'Part of <b>x</b>' });
    expect(m.html).toContain('Part of &lt;b&gt;x&lt;/b&gt;');
  });
  it('white-labelled sends never carry the endorsement, even when ON', () => {
    stubDeno({ PLATFORM_ENDORSEMENT_ENABLED: 'true', PLATFORM_PARENT_NAME: 'Acme Group' });
    const m = renderEmail({ ...base, brandName: 'Acme Plumbing' });
    expect(m.html).not.toMatch(/Part of Acme Group/);
    expect(m.text).not.toMatch(/Part of Acme Group/);
  });
  it('tenant email footer (applyFooter) is untouched when ON', () => {
    stubDeno({ PLATFORM_ENDORSEMENT_ENABLED: 'true', PLATFORM_PARENT_NAME: 'Acme Group' });
    const brand = composeEmailBrand({ companyName: 'Acme Plumbing', plan: 'pro', brand: { email_footer: 'Thanks!' }, email: null });
    const out = applyFooter('<p>x</p>', 'x', brand);
    expect(out.html + out.text).not.toMatch(/Part of/);
  });
});
