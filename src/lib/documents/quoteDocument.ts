/**
 * Quote / estimate on the Vireek document design system.
 * Pure: totals arrive pre-computed from the app's own pricing helpers
 * (quoteWorkspace.ts) so the PDF can never disagree with the screen.
 */

import { DocumentWriter, type DocBrandLike, type PdfDocLike } from './pdfKit';
import { formatDocDate, type DocLabels } from './locale';
import { DANGER, MUTED, SUCCESS, readableOn } from './tokens';

export interface QuoteDocItem { description: string; quantity: number; unit_price_cents: number }

export interface QuoteDocGroup {
  /** Option title (tiered quotes). Omit for a single flat estimate. */
  title?: string | null;
  subtitle?: string | null;
  warranty?: string | null;
  /** Localised tags such as "Recommended" / "Selected". */
  tags: string[];
  items: QuoteDocItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
  /** Show only the total (e.g. an accepted total that includes add-ons not itemised here). */
  totalOnly?: boolean;
}

export interface QuoteDocInput {
  businessName: string | null;
  /** Human reference. Quotes have no sequential number, so the adapter derives one from the id. */
  number: string;
  customerName: string;
  contact: string[];
  serviceAddress: string | null;
  issuedAt: string | null;
  validUntil: string | null;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
  taxPercent: number;
  taxExempt: boolean;
  depositPercent: number;
  note: string | null;
  groups: QuoteDocGroup[];
}

export interface QuoteDocEnv {
  brand: DocBrandLike;
  labels: DocLabels;
  localeTag: string;
  lang: string;
  rtl: boolean;
  money: (cents: number) => string;
  legalLine?: string | null;
}

export function renderQuoteDocument(doc: PdfDocLike, input: QuoteDocInput, env: QuoteDocEnv): PdfDocLike {
  const { labels: L, brand, money } = env;
  const accentText = readableOn(brand.primary);

  const w = new DocumentWriter(doc, {
    brand, lang: env.lang, rtl: env.rtl,
    title: `${L.quote} ${input.number}`,
    subject: input.businessName ?? L.quote,
    docNumber: input.number,
    pageLabel: { page: L.page, of: L.of },
    legalLine: env.legalLine,
  }).begin();

  const stamp =
    input.status === 'accepted' ? { text: L.accepted, color: SUCCESS }
    : input.status === 'declined' ? { text: L.declined, color: DANGER }
    : input.status === 'expired' ? { text: L.expired, color: DANGER }
    : null;

  w.titleBlock({ business: input.businessName || L.quote, kind: L.quote, number: input.number, stamp });

  w.metaRow([
    { at: 0, label: L.preparedFor, lines: [input.customerName || '\u2014', ...input.contact] },
    { at: 0.6, label: L.issued, lines: [formatDocDate(input.issuedAt, env.localeTag)] },
    { at: 0.8, label: L.validUntil, lines: [formatDocDate(input.validUntil, env.localeTag)] },
  ]);

  if (input.serviceAddress) {
    w.section(L.serviceAddress);
    w.paragraph(input.serviceAddress);
    w.y += 10;
  }

  const cols = [
    { header: L.description, weight: 0.5 },
    { header: L.qty, weight: 0.12, align: 'right' as const },
    { header: L.unit, weight: 0.18, align: 'right' as const },
    { header: L.amount, weight: 0.2, align: 'right' as const },
  ];

  input.groups.forEach((g, i) => {
    if (g.title) {
      w.ensure(90);
      if (i > 0) w.y += 8;
      w.section([g.title, ...g.tags].join(' \u00B7 '));
      if (g.subtitle) w.paragraph(g.subtitle, { color: MUTED });
      if (g.warranty) w.paragraph(`${L.warranty}: ${g.warranty}`, { size: 9, color: MUTED });
      w.y += 4;
    }
    w.table(cols, g.items.map((li) => [li.description || '\u2014', String(li.quantity), money(li.unit_price_cents), money(li.quantity * li.unit_price_cents)]));
    w.y += 4;
    w.summary([
      ...(g.totalOnly ? [] : [{ label: L.subtotal, value: money(g.subtotalCents) }]),
      ...(g.totalOnly ? []
        : input.taxExempt ? [{ label: L.tax, value: L.taxExempt }]
        : input.taxPercent > 0 ? [{ label: `${L.tax} (${input.taxPercent}%)`, value: money(g.taxCents) }] : []),
      { label: L.total, value: money(g.totalCents), bold: true, color: accentText },
      ...(g.depositCents > 0 ? [{ label: `${L.deposit} (${input.depositPercent}%)`, value: money(g.depositCents) }] : []),
    ]);
    w.y += 10;
  });

  if (input.note?.trim()) {
    w.y += 4;
    w.section(L.notes);
    w.paragraph(input.note.trim());
  }

  return w.finish();
}
