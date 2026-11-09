import { describe, expect, it } from 'vitest';
import {
  buildParentOrganizationJsonLd, isEndorsementSurfacePath, normalizePath, parseEnabled,
  resolveEndorsement, sanitizeParentName, sanitizeParentUrl,
} from './endorsement';

const BRAND = { name: 'Vireek', url: 'https://vireek.com' };

describe('parseEnabled', () => {
  it('enables only on true/1 (trimmed, any case)', () => {
    for (const v of ['true', 'TRUE', ' 1 ']) expect(parseEnabled(v)).toBe(true);
    for (const v of ['', 'false', '0', 'yes', 'on', 'truee', null, undefined]) expect(parseEnabled(v)).toBe(false);
  });
});

describe('sanitizeParentName', () => {
  it('collapses whitespace and trims', () => expect(sanitizeParentName('  Acme   Group ')).toBe('Acme Group'));
  it('rejects empty, markup, braces, control chars and over-long names', () => {
    for (const v of ['', '   ', '<b>x</b>', 'A {parent}', 'A\u0000B', 'x'.repeat(81), null, undefined]) {
      expect(sanitizeParentName(v as string)).toBeNull();
    }
  });
});

describe('sanitizeParentUrl', () => {
  it('accepts https only, without credentials', () => {
    expect(sanitizeParentUrl('https://acme.example')).toBe('https://acme.example/');
    for (const v of ['http://a.com', 'javascript:alert(1)', 'https://u:p@a.com', 'data:text/html,x', 'not a url', '', null]) {
      expect(sanitizeParentUrl(v as string)).toBeNull();
    }
  });
});

describe('resolveEndorsement', () => {
  it('flag OFF -> nothing, even with a parent set', () => {
    expect(resolveEndorsement({ parentName: 'Acme' }).line).toBeNull();
    expect(resolveEndorsement({ enabled: 'false', parentName: 'Acme' }).enabled).toBe(false);
  });
  it('flag ON + parent -> "Part of {parent}"', () => {
    const r = resolveEndorsement({ enabled: 'true', parentName: 'Acme Group', parentUrl: 'https://acme.example' });
    expect(r).toMatchObject({ enabled: true, parentName: 'Acme Group', line: 'Part of Acme Group', parentUrl: 'https://acme.example/' });
  });
  it('flag ON + parent null/invalid -> no line, no throw', () => {
    for (const parentName of [null, undefined, '', '<x>']) {
      expect(resolveEndorsement({ enabled: 'true', parentName }).line).toBeNull();
    }
  });
  it('drops an invalid URL but keeps the line', () => {
    expect(resolveEndorsement({ enabled: '1', parentName: 'Acme', parentUrl: 'http://x.com' })).toMatchObject({ line: 'Part of Acme', parentUrl: null });
  });
});

describe('buildParentOrganizationJsonLd', () => {
  it('is null when OFF or when the parent is unset', () => {
    expect(buildParentOrganizationJsonLd(resolveEndorsement({}), BRAND)).toBeNull();
    expect(buildParentOrganizationJsonLd(resolveEndorsement({ enabled: 'true' }), BRAND)).toBeNull();
  });
  it('adds parentOrganization when ON', () => {
    const ld = buildParentOrganizationJsonLd(resolveEndorsement({ enabled: 'true', parentName: 'Acme', parentUrl: 'https://acme.example' }), BRAND);
    expect(ld).toEqual({
      '@context': 'https://schema.org', '@type': 'Organization', name: 'Vireek', url: 'https://vireek.com',
      parentOrganization: { '@type': 'Organization', name: 'Acme', url: 'https://acme.example/' },
    });
  });
});

describe('isEndorsementSurfacePath (fail-closed)', () => {
  it('allows platform marketing/legal pages, tolerant of case, slash, query and hash', () => {
    for (const p of ['/', '/pricing', '/Pricing/', '/legal/company', '/privacy?x=1', '/blog/some-post', '/industries/hvac']) {
      expect(isEndorsementSurfacePath(p), p).toBe(true);
    }
    expect(normalizePath('/a/b/#h')).toBe('/a/b');
  });
  it('denies every tenant/customer-facing and app route', () => {
    const tenant = ['/quote/abc', '/book/acme', '/sign/t', '/portal/t/history', '/portal/t/inventory', '/approve/t', '/financing/t',
      '/inspection/t', '/invoice/t', '/pay/t', '/review/t', '/track/t', '/project/t', '/summary/t', '/reschedule/t', '/resolve/t',
      '/guarantee/t', '/findings/t', '/outcome/t', '/preferences/t', '/win/t', '/insights', '/dashboard', '/dashboard/jobs', '/login', '/unknown-new-page'];
    for (const p of tenant) expect(isEndorsementSurfacePath(p), p).toBe(false);
  });
});
