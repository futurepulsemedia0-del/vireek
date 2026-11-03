import { describe, expect, it } from 'vitest';
import { CHANGELOG_RELEASES, releaseSlug } from '@/lib/changelog';
import { buildAtom } from '../../scripts/lib/atom.mjs';

describe('changelog permalinks and feeds', () => {
  const slugs = CHANGELOG_RELEASES.map((r) => releaseSlug(r.date));

  it('derives unique ISO slugs, newest first', () => {
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort().reverse()).toEqual(slugs);
  });

  it('rejects unknown date formats', () => {
    expect(() => releaseSlug('Sept 6th')).toThrow();
  });

  it('only uses known entry types', () => {
    for (const r of CHANGELOG_RELEASES) for (const e of r.entries) expect(['new', 'improved', 'security', 'fixed']).toContain(e.type);
  });

  it('builds valid-looking Atom with escaped text', () => {
    const xml = buildAtom({
      title: 'T & Co',
      subtitle: 's',
      siteUrl: 'https://vireek.com',
      feedPath: '/changelog-atom.xml',
      linkPath: '/changelog',
      items: [{ id: 'https://vireek.com/changelog#2026-09-06', title: 'a <b>', link: 'https://vireek.com/changelog#2026-09-06', updated: '2026-09-06T00:00:00Z', summary: "x & 'y'", categories: ['security'] }],
    });
    expect(xml).toContain('<title>T &amp; Co</title>');
    expect(xml).toContain('a &lt;b&gt;');
    expect(xml).toContain('<category term="security"/>');
    expect(xml).toContain('<updated>2026-09-06T00:00:00Z</updated>');
  });
});
