import { describe, expect, it } from 'vitest';
import { LEGAL_DOCS, LEGAL_DOC_PATHS, getLegalDoc } from '@/lib/legalDocs';
import { LEGAL_CONTACT_EMAIL } from './types';

// Routes that already exist in App.tsx (cross-links must never 404).
const EXISTING = new Set([
  '/privacy', '/terms', '/msa', '/dpa', '/cookies', '/subprocessors', '/refund-policy', '/sla', '/acceptable-use-policy',
  '/responsible-ai', '/ai-disclosure', '/trademark-policy', '/dmca', '/vulnerability-disclosure', '/ccpa', '/data-request',
  '/security', '/trust', '/status', '/pricing', '/impressum',
]);
const KNOWN = new Set([...EXISTING, ...LEGAL_DOC_PATHS]);
const LINK = /\]\(([^)]+)\)/g;

function allText(d: (typeof LEGAL_DOCS)[number]): string[] {
  return d.sections.flatMap((s) => [...(s.paragraphs ?? []), ...(s.bullets ?? []), s.callout?.text ?? '']);
}

describe('legalDocs registry', () => {
  it('has unique slugs, paths and section ids', () => {
    expect(new Set(LEGAL_DOCS.map((d) => d.slug)).size).toBe(LEGAL_DOCS.length);
    expect(new Set(LEGAL_DOC_PATHS).size).toBe(LEGAL_DOCS.length);
    for (const d of LEGAL_DOCS) {
      expect(d.path).toBe(`/${d.slug}`);
      const ids = d.sections.map((s) => s.id);
      expect(new Set(ids).size, d.slug).toBe(ids.length);
      expect(d.description.length, d.slug).toBeGreaterThan(60);
      expect(d.description.length, d.slug).toBeLessThanOrEqual(200);
      expect(d.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.reviewStatus).toBe('pending-counsel');
      expect(d.sections.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('every internal link resolves to a real route and every related link too', () => {
    for (const d of LEGAL_DOCS) {
      for (const t of allText(d)) {
        for (const m of t.matchAll(LINK)) {
          const href = m[1];
          if (href.startsWith('/')) expect(KNOWN.has(href.split('#')[0]), `${d.slug}: ${href}`).toBe(true);
          else expect(href.startsWith('mailto:') || href.startsWith('https://'), `${d.slug}: ${href}`).toBe(true);
        }
      }
      for (const r of d.related) expect(KNOWN.has(r.href), `${d.slug} related ${r.href}`).toBe(true);
    }
  });

  it('only uses the verified contact email and makes no unverifiable compliance claims', () => {
    const banned = /SOC ?2|ISO ?27001|HIPAA[- ]compliant|PCI[- ]DSS (Level|certified)|99\.\d+%|Vireek[^.]*within \d+ (business )?(hours|days)/i;
    for (const d of LEGAL_DOCS) {
      for (const t of allText(d)) {
        for (const e of t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) expect(e).toBe(LEGAL_CONTACT_EMAIL);
        expect(t, d.slug).not.toMatch(banned);
      }
    }
  });

  it('stays consistent with the existing Privacy/Terms commitments', () => {
    const rec = allText(getLegalDoc('data-retention')!).join(' ');
    expect(rec).toMatch(/12 months/);
    const liab = allText(getLegalDoc('limitation-of-liability')!).join(' ');
    expect(liab).toMatch(/3 months/);
    const bill = allText(getLegalDoc('billing-terms')!).join(' ');
    expect(bill).toMatch(/30 days/);
  });

  it('getLegalDoc returns undefined for unknown slugs', () => {
    expect(getLegalDoc('nope')).toBeUndefined();
  });
});
