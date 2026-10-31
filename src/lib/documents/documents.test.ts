import { describe, expect, it } from 'vitest';
import { planTable } from './tablePlan';
import { contrastRatio, readableOn, onColor, INK, MUTED, SUCCESS, DANGER, type Rgb } from './tokens';
import { buildCsv, csvCell, exportFilename, neutralizeFormula, slugify, UTF8_BOM } from './exportFile';
import { docLabels, formatDocDate, isRtlLang, pdfLocaleTag, renderableLang } from './locale';
import { DocumentWriter, type DocBrandLike, type PdfDocLike } from './pdfKit';
import { renderInvoiceDocument, type InvoiceDocEnv, type InvoiceDocInput } from './invoiceDocument';
import { renderQuoteDocument, type QuoteDocEnv, type QuoteDocInput } from './quoteDocument';
import { renderReceiptDocument, type ReceiptDocEnv, type ReceiptDocInput } from './receiptDocument';

/** Recording fake: lets us assert layout without jsPDF. */
function fakeDoc() {
  const calls: { fn: string; args: unknown[] }[] = [];
  let page = 1;
  let pages = 1;
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn: `${fn}@${page}`, args }); return undefined; };
  const doc: PdfDocLike & { calls: typeof calls; props: Record<string, unknown> } = {
    calls,
    props: {},
    internal: { pageSize: { getWidth: () => 595.28, getHeight: () => 841.89 } },
    setFont: rec('setFont'), setFontSize: rec('setFontSize'), setTextColor: rec('setTextColor'),
    setFillColor: rec('setFillColor'), setDrawColor: rec('setDrawColor'), setLineWidth: rec('setLineWidth'),
    rect: rec('rect'), line: rec('line'), addImage: rec('addImage'),
    text: (t, x, y, o) => { calls.push({ fn: `text@${page}`, args: [t, x, y, o] }); },
    splitTextToSize: (t, w) => {
      const maxChars = Math.max(4, Math.floor(w / 5));
      const out: string[] = [];
      for (let i = 0; i < t.length; i += maxChars) out.push(t.slice(i, i + maxChars));
      return out.length ? out : [''];
    },
    addPage: () => { pages++; page = pages; },
    setPage: (n) => { page = n; },
    getNumberOfPages: () => pages,
    setProperties(p) { Object.assign(this.props, p); },
    setLanguage(l) { this.props.lang = l; },
  };
  return doc;
}
const texts = (d: ReturnType<typeof fakeDoc>, pg?: number) =>
  d.calls.filter((c) => (pg ? c.fn === `text@${pg}` : c.fn.startsWith('text@'))).map((c) => String(c.args[0]));

const brand = (over: Partial<DocBrandLike> = {}): DocBrandLike => ({
  wordmark: 'Acme HVAC', primary: [32, 58, 216], accent: [214, 88, 42], logo: null, attribution: 'Generated with Vireek', ...over,
});

describe('planTable', () => {
  it('fits everything on one page when it can', () => {
    const p = planTable({ rowHeights: [20, 20, 20], headerHeight: 20, startY: 100, pageTopY: 56, bottomY: 700 });
    expect(p).toEqual([{ from: 0, to: 3, startY: 100, newPage: false }]);
  });
  it('splits across pages and repeats the header start at pageTopY', () => {
    const p = planTable({ rowHeights: Array(10).fill(100), headerHeight: 20, startY: 100, pageTopY: 56, bottomY: 500 });
    expect(p.length).toBeGreaterThan(1);
    expect(p.flatMap((x) => Array.from({ length: x.to - x.from }, (_, i) => x.from + i))).toEqual([0,1,2,3,4,5,6,7,8,9]);
    p.slice(1).forEach((x) => { expect(x.startY).toBe(56); expect(x.newPage).toBe(true); });
  });
  it('never orphans a header: starts on a new page if header+1 row does not fit', () => {
    const p = planTable({ rowHeights: [100, 100], headerHeight: 20, startY: 450, pageTopY: 56, bottomY: 500 });
    expect(p[0]).toMatchObject({ from: 0, newPage: true, startY: 56 });
  });
  it('always progresses on a row taller than the page', () => {
    const p = planTable({ rowHeights: [2000, 30], headerHeight: 20, startY: 56, pageTopY: 56, bottomY: 700 });
    expect(p.map((x) => [x.from, x.to])).toEqual([[0, 1], [1, 2]]);
  });
  it('handles an empty table', () => {
    expect(planTable({ rowHeights: [], headerHeight: 20, startY: 80, pageTopY: 56, bottomY: 700 })).toHaveLength(1);
  });
});

describe('contrast tokens', () => {
  const white: Rgb = [255, 255, 255];
  it('computes WCAG ratios', () => {
    expect(contrastRatio([0, 0, 0], white)).toBeCloseTo(21, 0);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });
  it('body, muted, success and danger text pass AA (4.5:1) on white', () => {
    for (const c of [INK, MUTED, SUCCESS, DANGER]) expect(contrastRatio(c, white)).toBeGreaterThanOrEqual(4.5);
  });
  it('darkens an unreadable customer colour until it passes, keeping it unchanged when already fine', () => {
    const yellow: Rgb = [250, 220, 40];
    expect(contrastRatio(yellow, white)).toBeLessThan(4.5);
    expect(contrastRatio(readableOn(yellow), white)).toBeGreaterThanOrEqual(4.5);
    const navy: Rgb = [10, 20, 90];
    expect(readableOn(navy)).toBe(navy);
  });
  it('onColor picks a readable foreground for a brand band', () => {
    expect(onColor([10, 20, 90])).toEqual([255, 255, 255]);
    expect(onColor([250, 220, 40])).toEqual([0, 0, 0]);
  });
});

describe('CSV export', () => {
  it('prefixes a BOM and uses CRLF', () => {
    const out = buildCsv(['a', 'b'], [[1, 'x']]);
    expect(out.startsWith(UTF8_BOM)).toBe(true);
    expect(out).toBe(`${UTF8_BOM}a,b\r\n1,x`);
  });
  it('escapes commas, quotes and newlines', () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });
  it('neutralises formula injection in text but not in real numbers', () => {
    for (const evil of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) {
      expect(neutralizeFormula(evil).startsWith("'")).toBe(true);
    }
    expect(csvCell(-42.5)).toBe('-42.5');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(neutralizeFormula('safe')).toBe('safe');
  });
  it('quotes the delimiter when it is a semicolon and keeps non-Latin text intact', () => {
    expect(csvCell('a;b', ';')).toBe('"a;b"');
    expect(csvCell('فاکتور ۱۲۳')).toBe('فاکتور ۱۲۳');
  });
  it('serialises dates, booleans, null and non-finite numbers deterministically', () => {
    expect(csvCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(NaN)).toBe('');
    expect(csvCell(new Date('nope'))).toBe('');
  });
});

describe('export filenames', () => {
  const date = new Date('2026-10-30T12:00:00Z');
  it('builds {business}-{kind}-{date}.{ext}', () => {
    expect(exportFilename({ business: 'Acme HVAC & Co.', kind: 'Invoices', ext: 'csv', date })).toBe('acme-hvac-co-invoices-2026-10-30.csv');
  });
  it('falls back safely and strips path traversal / reserved names', () => {
    expect(exportFilename({ business: '../../etc/passwd', kind: 'calls', ext: 'xlsx', date })).toBe('etc-passwd-calls-2026-10-30.xlsx');
    expect(exportFilename({ business: null, kind: '', ext: 'pdf', date })).toBe('vireek-export-2026-10-30.pdf');
    expect(slugify('CON')).toBe('con-file');
    expect(slugify('é à ü')).toBe('e-a-u');
  });
  it('appends a bounded detail segment', () => {
    expect(exportFilename({ kind: 'report', ext: 'pdf', detail: 'Q3 2026', date })).toBe('vireek-report-2026-10-30-q3-2026.pdf');
  });
});

describe('document locale', () => {
  it('detects RTL languages', () => {
    expect(isRtlLang('fa')).toBe(true);
    expect(isRtlLang('ar-SA')).toBe(true);
    expect(isRtlLang('en')).toBe(false);
  });
  it('forces Latin digits for scripts we cannot draw yet', () => {
    const tag = pdfLocaleTag('fa-IR-u-ca-persian-nu-arabext');
    expect(tag).toContain('nu-latn');
    expect(tag).not.toContain('arabext');
    expect(new Intl.NumberFormat(tag).format(1234.5)).toMatch(/^1[,.\u00a0\u202f]?234[.,]5$/);
  });
  it('keeps the native locale when its font is embedded', () => {
    expect(pdfLocaleTag('fa-IR', new Set(['fa']))).toBe('fa-IR');
  });
  it('survives invalid locales', () => {
    expect(pdfLocaleTag('not a locale!!')).toContain('en-US');
  });
  it('falls back to English labels for unrenderable scripts, uses real labels for Latin-1 languages', () => {
    expect(renderableLang('fa')).toBe('en');
    expect(docLabels('ja').invoice).toBe('Invoice');
    expect(docLabels('de').invoice).toBe('Rechnung');
    expect(docLabels('fa', new Set(['fa'])).invoice).toBe('Invoice'); // no fa labels yet → English
  });
  it('formats date-only strings without a timezone day shift, and tolerates bad input', () => {
    expect(formatDocDate('2026-03-01', 'en-US-u-ca-gregory-nu-latn')).toBe('March 1, 2026');
    expect(formatDocDate(null, 'en-US')).toBe('—');
    expect(formatDocDate('garbage', 'en-US')).toBe('—');
  });
  it('every label set covers every key (no undefined text in a PDF)', () => {
    const keys = Object.keys(docLabels('en'));
    for (const l of ['es', 'fr', 'de']) expect(Object.keys(docLabels(l)).sort()).toEqual([...keys].sort());
  });
});

describe('DocumentWriter', () => {
  const mk = (b = brand(), extra = {}) =>
    new DocumentWriter(fakeDoc(), { brand: b, lang: 'en', title: 'T', docNumber: 'INV-1', pageLabel: { page: 'Page', of: 'of' }, ...extra });

  it('sets title/author/language metadata and never leaks Vireek when white-labelled', () => {
    const w = mk(brand({ attribution: null })).begin();
    const d = w.doc as ReturnType<typeof fakeDoc>;
    expect(d.props).toMatchObject({ title: 'T', author: 'Acme HVAC', creator: 'Acme HVAC', lang: 'en-US' });
    expect(JSON.stringify(d.props)).not.toMatch(/vireek/i);
  });
  it('writes "Page i of N" on every page and the attribution only when allowed', () => {
    const on = mk().begin();
    on.newPage(); on.newPage();
    on.finish();
    const d = on.doc as ReturnType<typeof fakeDoc>;
    for (const n of [1, 2, 3]) expect(texts(d, n).some((t) => t.includes(`Page ${n} of 3`))).toBe(true);
    expect(texts(d).filter((t) => t === 'Generated with Vireek')).toHaveLength(3);

    const off = mk(brand({ attribution: null })).begin();
    off.finish();
    expect(texts(off.doc as ReturnType<typeof fakeDoc>).join('|')).not.toMatch(/vireek/i);
  });
  it('draws the legal line (max 2 lines) above the page counter', () => {
    const w = mk(brand(), { legalLine: 'x'.repeat(2000) }).begin();
    w.finish();
    const legal = texts(w.doc as ReturnType<typeof fakeDoc>, 1).filter((t) => /^x+$/.test(t));
    expect(legal.length).toBe(2);
  });
  it('repeats the table header on every continuation page and never draws below the bottom margin', () => {
    const w = mk().begin();
    w.y = 120;
    const rows = Array.from({ length: 80 }, (_, i) => [`Item ${i}`, '1']);
    w.table([{ header: 'Description', weight: 3 }, { header: 'Qty', weight: 1, align: 'right' }], rows);
    w.finish();
    const d = w.doc as ReturnType<typeof fakeDoc>;
    const pages = d.getNumberOfPages();
    expect(pages).toBeGreaterThan(1);
    for (let p = 1; p <= pages; p++) expect(texts(d, p)).toContain('DESCRIPTION');
    const bottom = 841.89 - 64;
    for (const c of d.calls.filter((c) => c.fn.startsWith('text@'))) {
      const y = c.args[2] as number;
      const t = String(c.args[0]);
      if (/^Item \d+$/.test(t)) expect(y).toBeLessThanOrEqual(bottom);
    }
    expect(texts(d).filter((t) => /^Item \d+$/.test(t))).toHaveLength(80);
  });
  it('mirrors anchors and alignment for RTL', () => {
    const ltr = mk().begin(); ltr.text('hello', 48, 100, { align: 'left' });
    const rtl = mk(brand(), { rtl: true }).begin(); rtl.text('hello', 48, 100, { align: 'left' });
    const a = (ltr.doc as ReturnType<typeof fakeDoc>).calls.find((c) => c.fn.startsWith('text@') && c.args[0] === 'hello')!;
    const b = (rtl.doc as ReturnType<typeof fakeDoc>).calls.find((c) => c.fn.startsWith('text@') && c.args[0] === 'hello')!;
    expect(a.args[1]).toBe(48);
    expect(b.args[1]).toBeCloseTo(595.28 - 48, 5);
    expect((b.args[3] as { align: string }).align).toBe('right');
  });
  it('uses a text colour with AA contrast for pale brand colours', () => {
    const w = mk(brand({ primary: [250, 220, 40] })).begin();
    expect(contrastRatio(w.brandText, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('renderInvoiceDocument', () => {
  const invoice = {
    invoice_number: 'INV-1042', customer_name: 'Jane Doe', customer_email: 'jane@example.com', customer_phone: null,
    line_items: Array.from({ length: 3 }, (_, i) => ({ description: `Service ${i}`, quantity: 2, unit_price_cents: 5000 })),
    tax_percent: 10, status: 'sent', due_date: '2026-11-15', sent_at: '2026-10-30T10:00:00Z', created_at: '2026-10-29T10:00:00Z', notes: 'Thank you!',
  } as unknown as InvoiceDocInput['invoice'];
  const ledger = { subtotalCents: 30000, taxCents: 3000, totalCents: 33000, paidCents: 10000, refundedCents: 0, netPaidCents: 10000, balanceCents: 23000, state: 'partial' } as InvoiceDocInput['ledger'];
  const env = (over: Partial<InvoiceDocEnv> = {}): InvoiceDocEnv => ({
    brand: brand(), labels: docLabels('en'), localeTag: 'en-US-u-ca-gregory-nu-latn', lang: 'en', rtl: false,
    money: (c) => `$${(c / 100).toFixed(2)}`, paymentMethodLabel: (m) => m, ...over,
  });
  const input = (over: Partial<InvoiceDocInput> = {}): InvoiceDocInput => ({ invoice, ledger, payments: [], refunds: [], businessName: 'Acme HVAC', ...over });

  it('renders the key facts with correct math strings and a status stamp', () => {
    const d = fakeDoc();
    renderInvoiceDocument(d, input(), env());
    const t = texts(d).join('\n');
    for (const s of ['INVOICE', 'INV-1042', 'Jane Doe', 'jane@example.com', '$300.00', '$30.00', '$330.00', '-$100.00', '$230.00', 'PARTIALLY PAID', 'Tax (10%)', 'Thank you!', 'November 15, 2026']) {
      expect(t).toContain(s);
    }
    expect(d.props.title).toBe('Invoice INV-1042');
  });
  it('shows VOID with a zero balance for void invoices', () => {
    const d = fakeDoc();
    renderInvoiceDocument(d, input({ invoice: { ...invoice, status: 'void' } as InvoiceDocInput['invoice'] }), env());
    const t = texts(d);
    expect(t).toContain('VOID');
    expect(t).toContain('$0.00');
  });
  it('paginates long invoices, repeats headers, and numbers pages "x of y"', () => {
    const d = fakeDoc();
    const many = { ...invoice, line_items: Array.from({ length: 120 }, (_, i) => ({ description: `Line ${i}`, quantity: 1, unit_price_cents: 100 })) } as InvoiceDocInput['invoice'];
    renderInvoiceDocument(d, input({ invoice: many }), env());
    const pages = d.getNumberOfPages();
    expect(pages).toBeGreaterThan(2);
    for (let p = 1; p <= pages; p++) {
      expect(texts(d, p)).toContain('DESCRIPTION');
      expect(texts(d, p).some((x) => x.includes(`Page ${p} of ${pages}`))).toBe(true);
    }
  });
  it('white-label (no attribution): no "Vireek" anywhere in text or metadata', () => {
    const d = fakeDoc();
    renderInvoiceDocument(d, input(), env({ brand: brand({ attribution: null }) }));
    expect(texts(d).join(' ') + JSON.stringify(d.props)).not.toMatch(/vireek/i);
  });
  it('renders German labels and mirrors for RTL without throwing', () => {
    const d = fakeDoc();
    renderInvoiceDocument(d, input(), env({ labels: docLabels('de'), lang: 'de' }));
    expect(texts(d)).toContain('RECHNUNG');
    expect(() => renderInvoiceDocument(fakeDoc(), input(), env({ rtl: true }))).not.toThrow();
  });
  it('lists payments with refunds', () => {
    const d = fakeDoc();
    const payments = [{ id: 'p1', amount_cents: 10000, method: 'card', reference: 'ch_1', paid_at: '2026-10-31T00:00:00Z' }] as unknown as InvoiceDocInput['payments'];
    const refunds = [{ payment_id: 'p1', amount_cents: 2500 }] as unknown as InvoiceDocInput['refunds'];
    renderInvoiceDocument(d, input({ payments, refunds }), env());
    const t = texts(d).join('\n');
    expect(t).toContain('PAYMENT HISTORY');
    expect(t).toContain('-$25.00');
  });
});


const money2 = (c: number) => `$${(c / 100).toFixed(2)}`;
const baseEnv = { brand: brand(), labels: docLabels('en'), localeTag: 'en-US-u-ca-gregory-nu-latn', lang: 'en', rtl: false, money: money2 };

describe('renderQuoteDocument', () => {
  const item = (n: number) => ({ description: `Item ${n}`, quantity: 2, unit_price_cents: 1000 });
  const group = (over = {}) => ({ tags: [], items: [item(1), item(2)], subtotalCents: 4000, taxCents: 400, totalCents: 4400, depositCents: 0, ...over });
  const input = (over: Partial<QuoteDocInput> = {}): QuoteDocInput => ({
    businessName: 'Acme HVAC', number: 'Q-AB12CD34', customerName: 'Jane Doe', contact: ['jane@example.com'], serviceAddress: '1 Main St, Austin, TX, 78701',
    issuedAt: '2026-10-30T10:00:00Z', validUntil: '2026-11-30', status: 'sent', taxPercent: 10, taxExempt: false, depositPercent: 0, note: 'Valid for 30 days.',
    groups: [group()], ...over,
  });
  const env = (over: Partial<QuoteDocEnv> = {}): QuoteDocEnv => ({ ...baseEnv, ...over });

  it('renders a flat estimate with totals, address, dates and note', () => {
    const d = fakeDoc();
    renderQuoteDocument(d, input(), env());
    const t = texts(d).join('\n');
    for (const s of ['QUOTE', 'Q-AB12CD34', 'Jane Doe', '1 Main St, Austin, TX, 78701', 'November 30, 2026', '$40.00', '$4.00', '$44.00', 'Tax (10%)', 'Valid for 30 days.']) expect(t).toContain(s);
    expect(d.props.title).toBe('Quote Q-AB12CD34');
  });
  it('renders tiered options with tags and a deposit row', () => {
    const d = fakeDoc();
    renderQuoteDocument(d, input({ depositPercent: 25, groups: [
      group({ title: 'Good — Basic', tags: ['Recommended'], depositCents: 1100 }),
      group({ title: 'Best — Premium', tags: [], totalCents: 9000, subtotalCents: 8000, taxCents: 1000 }),
    ] }), env());
    const t = texts(d).join('\n');
    expect(t).toContain('GOOD — BASIC · RECOMMENDED');
    expect(t).toContain('BEST — PREMIUM');
    expect(t).toContain('Deposit due on acceptance (25%)');
    expect(t).toContain('$11.00');
  });
  it('stamps accepted/declined/expired and shows only the total when totalOnly', () => {
    const d = fakeDoc();
    renderQuoteDocument(d, input({ status: 'accepted', groups: [group({ totalOnly: true, totalCents: 5000 })] }), env());
    const t = texts(d);
    expect(t).toContain('ACCEPTED');
    expect(t).toContain('$50.00');
    expect(t).not.toContain('Subtotal');
    const e = fakeDoc();
    renderQuoteDocument(e, input({ status: 'expired' }), env());
    expect(texts(e)).toContain('EXPIRED');
  });
  it('tax-exempt customers see "Tax exempt" instead of a tax amount', () => {
    const d = fakeDoc();
    renderQuoteDocument(d, input({ taxExempt: true }), env());
    expect(texts(d)).toContain('Tax exempt');
    expect(texts(d).join(' ')).not.toContain('Tax (10%)');
  });
  it('paginates a long quote and white-label leaks nothing', () => {
    const d = fakeDoc();
    renderQuoteDocument(d, input({ groups: [group({ items: Array.from({ length: 100 }, (_, i) => item(i)) })] }), env({ brand: brand({ attribution: null }) }));
    const pages = d.getNumberOfPages();
    expect(pages).toBeGreaterThan(1);
    for (let p = 1; p <= pages; p++) expect(texts(d, p).some((x) => x.includes(`Page ${p} of ${pages}`))).toBe(true);
    expect(texts(d).join(' ') + JSON.stringify(d.props)).not.toMatch(/vireek/i);
  });
});

describe('renderReceiptDocument', () => {
  const input = (over: Partial<ReceiptDocInput> = {}): ReceiptDocInput => ({
    businessName: 'Acme HVAC', number: 'RCT-1A2B3C4D', invoiceNumber: 'INV-1042', customerName: 'Jane Doe', contact: [],
    paidAt: '2026-10-31T00:00:00Z', methodLabel: 'Card', reference: 'ch_1', note: null,
    amountCents: 10000, refundedCents: 0, invoiceTotalCents: 33000, totalPaidCents: 10000, balanceCents: 23000, ...over,
  });
  it('shows the payment, running totals and a PAID stamp', () => {
    const d = fakeDoc();
    renderReceiptDocument(d, input(), { ...baseEnv } as ReceiptDocEnv);
    const t = texts(d).join('\n');
    for (const s of ['RECEIPT', 'RCT-1A2B3C4D', 'PAID', 'INV-1042', 'Reference: ch_1', '$100.00', '$330.00', '$230.00', 'October 31, 2026']) expect(t).toContain(s);
    expect(d.getNumberOfPages()).toBe(1);
  });
  it('shows refunds against the payment', () => {
    const d = fakeDoc();
    renderReceiptDocument(d, input({ refundedCents: 2500 }), { ...baseEnv } as ReceiptDocEnv);
    expect(texts(d)).toContain('-$25.00');
  });
});
