import { jsPDF } from 'jspdf';
import { VIREEK_PDF_BRAND } from '@/lib/pdfBrand';
import { buildDocument, type RenderMode } from './render';
import type { ProofCase, ProofConsent, ProofSource } from './method';

// Vector text only. Always the Vireek brand: this is a Vireek-issued proof document, not a tenant-branded one.
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const PAGE_W = 595.28, PAGE_H = 841.89, M = 48, W = PAGE_W - M * 2, BOTTOM = PAGE_H - 60;

/** Throws PublicationBlockedError in "public" mode when the gate fails (same rule as the Markdown output). */
export function buildCasePdf(c: ProofCase, sources: readonly ProofSource[], consents: readonly ProofConsent[], mode: RenderMode, businessName: string | null = null): jsPDF {
  const d = buildDocument(c, sources, consents, mode, businessName);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = 0;
  const footer = () => {
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    doc.text(`${d.verification}`.slice(0, 160), M, PAGE_H - 30, { maxWidth: W });
  };
  const header = () => {
    doc.setFillColor(...VIREEK_PDF_BRAND.primary); doc.rect(0, 0, PAGE_W, 6, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...VIREEK_PDF_BRAND.primary); doc.text(VIREEK_PDF_BRAND.wordmark, M, 40);
    footer(); y = 70;
  };
  const para = (text: string, size = 10, bold = false, color = INK) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(size).setTextColor(...color);
    for (const line of doc.splitTextToSize(text, W) as string[]) {
      if (y + size * 1.4 > BOTTOM) { doc.addPage(); header(); doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(size).setTextColor(...color); }
      doc.text(line, M, y); y += size * 1.4;
    }
    y += 4;
  };
  header();
  para(d.title.replace(/\\/g, ''), 20, true);
  if (d.banner) para(d.banner, 10, true, VIREEK_PDF_BRAND.accent);
  para(d.verification, 10, true);
  para(`${d.businessLabel}${d.personLabel ? `, ${d.personLabel}` : ''}. Period: ${d.period}.`.replace(/\\/g, ''));
  for (const f of d.facts) para(`${f.label}: ${f.value}`);
  para(d.roiLine, 10, true);
  if (d.quote) para(`"${d.quote.replace(/\\/g, '')}" (approved in writing by the customer)`, 10, false, MUTED);
  para('How this was calculated', 12, true);
  d.methodLines.forEach((l) => para(`- ${l}`));
  if (d.excludedLines.length) { para('Left out', 12, true); d.excludedLines.forEach((l) => para(`- ${l}`)); }
  para('Integrity and consent', 12, true); para(d.integrity, 9); para(d.consentLine.replace(/\\/g, ''), 9);
  if (d.sourceRows.length) {
    para('Source events (audit trail)', 12, true);
    for (const r of d.sourceRows) para(`${r.date}  ${r.type}  ${r.amount}  ${r.confidence}  ${r.status}  ref: ${r.evidenceRef.replace(/\\/g, '')}  id: ${r.id}`, 8);
  }
  return doc;
}
