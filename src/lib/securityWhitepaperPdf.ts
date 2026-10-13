/**
 * Security Whitepaper — PDF export.
 *
 * Vector text laid out by hand with jsPDF (same approach as src/lib/pdf.ts): crisp,
 * small, no DOM screenshotting. jsPDF is imported lazily so it never touches the
 * initial bundle. Content comes from `securityWhitepaper.ts`, the same source the
 * public page renders, so the PDF always matches the page.
 */

import type { jsPDF as JsPdfDocument } from 'jspdf';
import {
  RELATED_DOCS,
  SECTIONS,
  SITE_ORIGIN,
  WHITEPAPER,
  WHITEPAPER_FILENAME,
  formatWhitepaperDate,
} from '@/lib/securityWhitepaper';

type RGB = [number, number, number];

const ACCENT: RGB = [32, 58, 216]; // --accent-primary (light)
const CTA: RGB = [214, 88, 42]; // --accent-secondary (light)
const INK: RGB = [23, 23, 23];
const MUTED: RGB = [110, 110, 120];
const LINE: RGB = [225, 225, 232];

const PAGE_W = 595.28; // A4 in pt
const PAGE_H = 841.89;
const M = 56;
const CW = PAGE_W - M * 2;
const BOTTOM = PAGE_H - 72; // keep clear of the footer

export async function buildSecurityWhitepaperPdf(): Promise<JsPdfDocument> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });

  doc.setProperties({
    title: WHITEPAPER.title,
    subject: 'Security whitepaper',
    author: 'Vireek',
    keywords: 'security, whitepaper, Vireek',
    creator: 'vireek.com',
  });

  let y = 0;

  const ensure = (needed: number) => {
    if (y + needed > BOTTOM) {
      doc.addPage();
      y = M;
    }
  };

  const write = (
    value: string,
    o: { size?: number; bold?: boolean; color?: RGB; indent?: number; gap?: number; leading?: number } = {},
  ) => {
    const { size = 10.5, bold = false, color = INK, indent = 0, gap = 8, leading = 1.5 } = o;
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(value, CW - indent) as string[];
    for (const line of lines) {
      ensure(size * leading);
      doc.text(line, M + indent, y);
      y += size * leading;
    }
    y += gap;
  };

  const heading = (index: number, title: string) => {
    ensure(80); // keep a heading together with at least a few lines of body
    y += 14;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...INK);
    doc.text(`${index}. ${title}`, M, y);
    y += 9;
    doc.setDrawColor(...LINE);
    doc.setLineWidth(1);
    doc.line(M, y, PAGE_W - M, y);
    y += 20;
  };

  const bullets = (items: string[]) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    for (const item of items) {
      const lines = doc.splitTextToSize(item, CW - 18) as string[];
      ensure(lines.length * 15.75);
      doc.setFillColor(...ACCENT);
      doc.circle(M + 4, y - 3.6, 1.6, 'F');
      doc.setTextColor(...INK);
      for (const line of lines) {
        doc.text(line, M + 18, y);
        y += 15.75;
      }
      y += 3;
    }
    y += 6;
  };

  // ---- Cover block -------------------------------------------------------
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 6, 'F');

  y = 52;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...ACCENT);
  doc.text('Vireek', M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('AI Voice Receptionist for Home Service Businesses', M, y + 13);

  y += 58;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...CTA);
  doc.text('SECURITY WHITEPAPER', M, y);

  y += 28;
  write('How Vireek protects your business data', { size: 24, bold: true, leading: 1.25, gap: 10 });
  write(`Version ${WHITEPAPER.version}  \u00B7  Updated ${formatWhitepaperDate()}  \u00B7  ${SITE_ORIGIN}${WHITEPAPER.path}`, {
    size: 9.5,
    color: MUTED,
    gap: 4,
  });

  // ---- Sections ----------------------------------------------------------
  SECTIONS.forEach((section, i) => {
    heading(i + 1, section.title);
    for (const block of section.blocks) {
      if (block.type === 'p') {
        write(block.text);
      } else if (block.type === 'ul') {
        bullets(block.items);
      } else {
        for (const item of block.items) {
          ensure(46);
          write(item.term, { bold: true, gap: 2 });
          write(item.text, { color: MUTED, gap: 10 });
        }
      }
    }
  });

  // ---- Related documents -------------------------------------------------
  ensure(80);
  y += 14;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...INK);
  doc.text('Related documents', M, y);
  y += 9;
  doc.setDrawColor(...LINE);
  doc.line(M, y, PAGE_W - M, y);
  y += 20;
  for (const d of RELATED_DOCS) {
    ensure(34);
    write(d.label, { bold: true, gap: 1 });
    write(`${SITE_ORIGIN}${d.href}`, { size: 9.5, color: ACCENT, gap: 8 });
  }

  // ---- Footer on every page ---------------------------------------------
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(1);
    doc.line(M, PAGE_H - 50, PAGE_W - M, PAGE_H - 50);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`${WHITEPAPER.title}  \u00B7  v${WHITEPAPER.version}  \u00B7  vireek.com`, M, PAGE_H - 34);
    doc.text(`Page ${p} of ${total}`, PAGE_W - M, PAGE_H - 34, { align: 'right' });
  }

  return doc;
}

export async function downloadSecurityWhitepaperPdf(): Promise<void> {
  const doc = await buildSecurityWhitepaperPdf();
  doc.save(WHITEPAPER_FILENAME);
}
