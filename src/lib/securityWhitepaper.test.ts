import { describe, expect, it } from 'vitest';
import {
  RELATED_DOCS,
  SECTIONS,
  SECTION_IDS,
  WHITEPAPER,
  WHITEPAPER_FILENAME,
  allWhitepaperText,
  estimateReadMinutes,
  formatWhitepaperDate,
} from '@/lib/securityWhitepaper';
import { buildSecurityWhitepaperPdf } from '@/lib/securityWhitepaperPdf';

describe('whitepaper content', () => {
  it('has unique, URL-safe section ids and no empty sections', () => {
    expect(new Set(SECTION_IDS).size).toBe(SECTIONS.length);
    for (const s of SECTIONS) {
      expect(s.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(s.title.trim()).not.toBe('');
      expect(s.blocks.length).toBeGreaterThan(0);
    }
  });

  it('contains no empty strings', () => {
    for (const t of allWhitepaperText()) expect(t.trim()).not.toBe('');
  });

  it('never claims a certification or attestation Vireek does not hold', () => {
    const text = allWhitepaperText().join('\n');
    expect(text).not.toMatch(/\b(SOC ?2|ISO ?27001|HIPAA|PCI[- ]?DSS|FedRAMP|GDPR[- ]compliant)\b[^.]*\b(certified|compliant|attested|audited|report|level)\b/i);
    expect(text).not.toMatch(/\b(certified|compliant|attested)\b[^.]*\b(SOC ?2|ISO ?27001|HIPAA|PCI[- ]?DSS|FedRAMP)\b/i);
  });

  it('only uses characters the PDF font can render', () => {
    const safe = /^[\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D]*$/;
    for (const t of [...allWhitepaperText(), ...RELATED_DOCS.map((d) => d.label + d.description)]) {
      expect(t).toMatch(safe);
    }
  });

  it('links related documents to internal paths', () => {
    for (const d of RELATED_DOCS) expect(d.href).toMatch(/^\/[a-z-]+$/);
  });

  it('formats the date independent of timezone and estimates a sane read time', () => {
    expect(formatWhitepaperDate('2026-10-08')).toBe('October 8, 2026');
    expect(estimateReadMinutes()).toBeGreaterThanOrEqual(1);
    expect(estimateReadMinutes()).toBeLessThan(30);
    expect(WHITEPAPER_FILENAME).toBe(`Vireek-Security-Whitepaper-v${WHITEPAPER.version}.pdf`);
  });
});

describe('whitepaper PDF', () => {
  it('builds a valid multi-page A4 document', async () => {
    const doc = await buildSecurityWhitepaperPdf();
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(2);
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect(new TextDecoder('latin1').decode(bytes)).toContain(WHITEPAPER.title);
  });
});
