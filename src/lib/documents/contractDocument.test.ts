import { describe, expect, it } from 'vitest';
import { renderContractDocument, type ContractDocEnv, type ContractDocInput } from './contractDocument';
import { docLabels } from './locale';
import type { PdfDocLike } from './pdfKit';

function fakeDoc() {
  const texts: { page: number; t: string }[] = [];
  let page = 1;
  let pages = 1;
  const props: Record<string, unknown> = {};
  const noop = () => undefined;
  const doc: PdfDocLike = {
    internal: { pageSize: { getWidth: () => 595.28, getHeight: () => 841.89 } },
    setFont: noop, setFontSize: noop, setTextColor: noop, setFillColor: noop, setDrawColor: noop, setLineWidth: noop,
    rect: noop, line: noop, addImage: noop,
    text: (t) => { texts.push({ page, t: Array.isArray(t) ? t.join(' ') : t }); },
    splitTextToSize: (t, w) => {
      const n = Math.max(4, Math.floor(w / 5));
      const out: string[] = [];
      for (let i = 0; i < t.length; i += n) out.push(t.slice(i, i + n));
      return out.length ? out : [''];
    },
    addPage: () => { pages++; page = pages; },
    setPage: (n) => { page = n; },
    getNumberOfPages: () => pages,
    setProperties: (p) => { Object.assign(props, p); },
    setLanguage: (l) => { props.lang = l; },
  };
  return { doc, texts, props, pageCount: () => pages };
}

const env: ContractDocEnv = {
  brand: { wordmark: 'Acme', primary: [32, 58, 216], accent: [214, 88, 42], logo: null, attribution: null },
  labels: docLabels('en'), localeTag: 'en-US', lang: 'en', rtl: false,
  kindLabel: 'Agreement', integrityLabel: 'Integrity', voidLabel: 'VOID',
  legalLine: 'Template draft - have qualified counsel review before use.',
};
const input = (over: Partial<ContractDocInput> = {}): ContractDocInput => ({
  businessName: 'Acme HVAC', title: 'Service agreement', number: 'AGR-1042', customerName: 'Jordan Rivera',
  contact: ['jordan@example.com'], issuedAt: '2026-06-01', body: '# Scope\nWork as agreed.\n\n## Payment\nNet 30.',
  bodySha256: 'a'.repeat(64), ...over,
});

describe('renderContractDocument', () => {
  it('writes title, headings, paragraphs, hash and the counsel-review legal line', () => {
    const f = fakeDoc();
    renderContractDocument(f.doc, input(), env);
    const all = f.texts.map((x) => x.t).join('|');
    expect(all).toContain('Acme HVAC');
    expect(all).toContain('SCOPE');
    expect(all).toContain('Work as agreed.');
    expect(all).toContain('PAYMENT');
    expect(all).toContain(`SHA-256: ${'a'.repeat(64)}`);
    expect(all).toContain('qualified counsel');
    expect(f.props.title).toBe('Service agreement');
  });

  it('stamps voided documents', () => {
    const f = fakeDoc();
    renderContractDocument(f.doc, input({ voided: true }), env);
    expect(f.texts.some((x) => x.t === 'VOID')).toBe(true);
  });

  it('paginates long bodies without dropping text', () => {
    const f = fakeDoc();
    const body = Array.from({ length: 200 }, (_, i) => `Clause ${i}: obligations apply.`).join('\n');
    renderContractDocument(f.doc, input({ body }), env);
    expect(f.pageCount()).toBeGreaterThan(1);
    expect(f.texts.some((x) => x.t.includes('Clause 199'))).toBe(true);
  });
});
