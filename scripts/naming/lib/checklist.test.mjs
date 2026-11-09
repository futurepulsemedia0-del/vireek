// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MANUAL_DEFAULT, NICE_CLASSES, buildChecklist, spellingVariants } from './checklist.mjs';

describe('buildChecklist', () => {
  const domains = [
    { tld: 'com', status: 'registered' },
    { tld: 'ai', status: 'no RDAP record found (UNVERIFIED, confirm at a registrar)' },
    { tld: 'io', status: 'lookup error' },
  ];
  const c = buildChecklist('vireek', domains);

  it('lists the required databases with URLs', () => {
    const urls = c.databases.flatMap((d) => d.urls).join(' ');
    expect(urls).toContain('branddb.wipo.int');
    expect(urls).toContain('tmsearch.uspto.gov');
    expect(urls).toContain('euipo.europa.eu');
    expect(urls).toContain('tmdn.org/tmview');
  });
  it('covers Nice classes 9, 35, 36, 42, 44 for every database', () => {
    expect(NICE_CLASSES.map((n) => n.no)).toEqual([9, 35, 36, 42, 44]);
    for (const d of c.databases) expect(d.classes.map((n) => n.no)).toEqual([9, 35, 36, 42, 44]);
  });
  it('includes social handle URLs built from the name', () => {
    expect(c.social.map((s) => s.id)).toEqual(expect.arrayContaining(['instagram', 'x', 'linkedin', 'tiktok', 'github']));
    for (const s of c.social) expect(s.url).toContain('vireek');
  });
  it('defaults every item to NOT DONE', () => {
    const all = [...c.databases, ...c.social, ...c.other].map((i) => i.status);
    expect(all.every((s) => s === MANUAL_DEFAULT)).toBe(true);
    expect(MANUAL_DEFAULT).toBe('NOT DONE');
  });
  it('requires registrar confirmation for every non-registered TLD and an attorney review', () => {
    expect(c.registrarTlds).toEqual(['ai', 'io']);
    expect(c.other.map((o) => o.id)).toContain('attorney');
  });
});

describe('spellingVariants', () => {
  it('is deterministic, excludes the name and stays bounded', () => {
    const v = spellingVariants('phoenix');
    expect(v).toEqual(spellingVariants('phoenix'));
    expect(v).not.toContain('phoenix');
    expect(v.length).toBeLessThanOrEqual(8);
    expect(v).toContain('foenix');
  });
});
