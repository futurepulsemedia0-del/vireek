import { describe, expect, it } from 'vitest';
import type { DocBrandLike, PdfDocLike } from '@/lib/documents/pdfKit';
import { parseStatement } from '@/lib/partnerStatement';
import { latin1Safe, renderPartnerStatement, statementNumber } from '@/lib/partnerStatementPdf';

function fakeDoc() {
  const texts: string[] = [];
  let pages = 1;
  const doc: PdfDocLike = {
    internal: { pageSize: { getWidth: () => 595, getHeight: () => 842 } },
    setFont: () => undefined,
    setFontSize: () => undefined,
    setTextColor: () => undefined,
    setFillColor: () => undefined,
    setDrawColor: () => undefined,
    setLineWidth: () => undefined,
    rect: () => undefined,
    line: () => undefined,
    text: (t) => { texts.push(...(Array.isArray(t) ? t : [t])); },
    splitTextToSize: (t) => [t],
    addPage: () => { pages += 1; },
    setPage: () => undefined,
    getNumberOfPages: () => pages,
    addImage: () => undefined,
    setProperties: () => undefined,
  };
  return { doc, texts, pageCount: () => pages };
}

const brand: DocBrandLike = { wordmark: 'Vireek', primary: [20, 60, 140], accent: [20, 60, 140], logo: null, attribution: 'Generated with Vireek' };

const raw = (lines: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'po1', partner_id: 'p1', source: 'monthly', period_start: '2026-04-01', period_end: '2026-04-30', status: 'calculated',
  gross_cents: 3125, clawback_cents: -1294, net_cents: 1831, min_payout_cents: 1000, entry_count: lines.length, agreement_version: 1,
  calculated_at: '2026-05-02T00:00:00Z',
  statement: {
    partner: { company_name: 'Acme \u041c\u0435\u0434\u0438\u0430', tier: 'affiliate', channel: 'youtube', referral_code: 'ACME1234', commission_rate: 12.5, commission_months: 12 },
    agreement: { version: 1, revenue_share_pct: 12.5, term_months: 12, min_payout_cents: 1000, document_ref: 'SECRET-DOC-REF' },
    held_cents: 0, rounding_mismatches: 0, carried_in_cents: 0, lines,
  },
  ...over,
});
const line = (i: number, amount: number, type = 'earn') => ({ id: `id${i}`.padEnd(8, 'x'), entry_type: type, earned_at: '2026-03-25T00:00:00Z', period_index: type === 'earn' ? 1 : null, base_cents: type === 'earn' ? 20000 : null, rate_pct: type === 'earn' ? 12.5 : null, amount_cents: amount, stripe_invoice_id: `in_${i}`, ref: `id${i}`.padEnd(8, 'x') });

describe('renderPartnerStatement', () => {
  it('prints the totals, the lines and the footnote, and never throws', () => {
    const s = parseStatement(raw([line(1, 2500), line(2, -494, 'clawback')]));
    if (!s) throw new Error('fixture');
    const { doc, texts } = fakeDoc();
    renderPartnerStatement(doc, s, brand, { audience: 'partner' });
    const all = texts.join('\n');
    expect(all).toContain('$31.25');
    expect(all).toContain('-$12.94');
    expect(all).toContain('$18.31');
    expect(all).toContain('-$4.94');
    expect(all).toContain('April 2026');
    expect(all).toContain('PS-2026-04-ACME1234');
    expect(all).toContain('Clawback');
  });
  it('the partner copy hides the internal document reference; the finance copy shows it', () => {
    const s = parseStatement(raw([line(1, 2500)]));
    if (!s) throw new Error('fixture');
    const partner = fakeDoc();
    renderPartnerStatement(partner.doc, s, brand, { audience: 'partner' });
    expect(partner.texts.join('\n')).not.toContain('SECRET-DOC-REF');
    const finance = fakeDoc();
    renderPartnerStatement(finance.doc, s, brand, { audience: 'finance' });
    expect(finance.texts.join('\n')).toContain('SECRET-DOC-REF');
  });
  it('replaces characters the PDF font cannot draw instead of garbling them', () => {
    const s = parseStatement(raw([line(1, 2500)]));
    if (!s) throw new Error('fixture');
    const { doc, texts } = fakeDoc();
    renderPartnerStatement(doc, s, brand);
    expect(texts.join('\n')).toContain('Acme ?????');
  });
  it('paginates a long statement', () => {
    const many = Array.from({ length: 150 }, (_, i) => line(i, 100));
    const s = parseStatement(raw(many, { gross_cents: 15000, clawback_cents: 0, net_cents: 15000 }));
    if (!s) throw new Error('fixture');
    const { doc, pageCount } = fakeDoc();
    renderPartnerStatement(doc, s, brand);
    expect(pageCount() > 1).toBe(true);
  });
  it('explains a negative balance and an empty statement', () => {
    const s = parseStatement(raw([], { status: 'carried_forward', carry_reason: 'negative_balance', gross_cents: 0, clawback_cents: -669, net_cents: -669 }));
    if (!s) throw new Error('fixture');
    const { doc, texts } = fakeDoc();
    renderPartnerStatement(doc, s, brand);
    const all = texts.join('\n');
    expect(all).toContain('NEGATIVE BALANCE');
    expect(all).toContain('No payable entries');
    expect(all).toContain('-$6.69');
  });
});

describe('helpers', () => {
  it('latin1Safe keeps Latin-1 and maps typographic dashes/apostrophes', () => {
    expect(latin1Safe('Caf\u00e9 \u2014 O\u2019Neil \u0416')).toBe("Caf\u00e9 - O'Neil ?");
  });
  it('statementNumber falls back for ad-hoc rows', () => {
    expect(statementNumber({ id: 'abcdef123456', period_start: null, partner: { referral_code: '' } as never })).toBe('PS-ADHOC-ABCDEF12');
  });
});
