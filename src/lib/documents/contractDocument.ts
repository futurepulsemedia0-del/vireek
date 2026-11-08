/**
 * Contract / notice PDF on the Vireek document design system (pdfKit DocumentWriter).
 * Pure: the text arrives already merged and hashed by the Template Studio engine, so the PDF can never
 * disagree with the stored snapshot. Body convention: "# Heading" / "## Heading" lines become section
 * headings, blank lines add spacing, everything else is a paragraph.
 */
import { DocumentWriter, type DocBrandLike, type PdfDocLike } from './pdfKit';
import { formatDocDate, type DocLabels } from './locale';
import { DANGER, MUTED } from './tokens';

export interface ContractDocInput {
  businessName: string | null;
  title: string;
  /** Human reference, e.g. generated_documents.id short form. */
  number: string;
  customerName: string | null;
  contact: string[];
  issuedAt: string | null;
  body: string;
  bodySha256: string;
  voided?: boolean;
}

export interface ContractDocEnv {
  brand: DocBrandLike;
  labels: DocLabels;
  localeTag: string;
  lang: string;
  rtl: boolean;
  /** Localised by the caller (i18next): document kind, e.g. "Agreement". */
  kindLabel: string;
  integrityLabel: string;
  voidLabel: string;
  /** Localised "template draft — have qualified counsel review before use" line. */
  legalLine: string;
}

export const MAX_PDF_LINES = 4_000;

export function renderContractDocument(doc: PdfDocLike, input: ContractDocInput, env: ContractDocEnv): PdfDocLike {
  const { labels: L, brand } = env;
  const w = new DocumentWriter(doc, {
    brand, lang: env.lang, rtl: env.rtl,
    title: input.title,
    subject: input.businessName ?? env.kindLabel,
    docNumber: input.number,
    pageLabel: { page: L.page, of: L.of },
    legalLine: env.legalLine,
  }).begin();

  w.titleBlock({
    business: input.businessName || env.kindLabel,
    kind: env.kindLabel,
    number: input.number,
    stamp: input.voided ? { text: env.voidLabel, color: DANGER } : null,
  });

  w.metaRow([
    { at: 0, label: L.preparedFor, lines: [input.customerName || '\u2014', ...input.contact] },
    { at: 0.7, label: L.issued, lines: [formatDocDate(input.issuedAt, env.localeTag)] },
  ]);

  const lines = input.body.split(/\r?\n/).slice(0, MAX_PDF_LINES);
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^#{1,2}\s+(.+)$/.exec(line);
    if (heading) {
      w.y += 8;
      w.section(heading[1]!);
    } else if (line.trim() === '') {
      w.y += 6;
    } else {
      w.paragraph(line);
    }
  }

  w.y += 16;
  w.section(env.integrityLabel);
  w.paragraph(`SHA-256: ${input.bodySha256}`, { size: 8, color: MUTED });
  return w.finish();
}
