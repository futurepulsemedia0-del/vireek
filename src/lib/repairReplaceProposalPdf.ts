import { usd } from '@/lib/repairReplaceAdvisor';
import type { Proposal } from '@/lib/repairReplaceProposal';

/**
 * Branded customer proposal PDF. Vector text only; jsPDF is loaded on demand so it never bloats the main bundle.
 * Everything printed comes from the Proposal object, nothing is invented here.
 */

type Rgb = [number, number, number];
const ACCENT: Rgb = [32, 58, 216];
const INK: Rgb = [23, 23, 23];
const MUTED: Rgb = [110, 110, 120];
const SUCCESS: Rgb = [22, 130, 87];
const LINE: Rgb = [225, 225, 232];
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const CW = PAGE_W - M * 2;

export async function buildProposalPdf(p: Proposal): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = M;

  const ensure = (needed: number) => {
    if (y + needed > PAGE_H - 56) {
      doc.addPage();
      y = M;
    }
  };
  const write = (text: string, o: { size?: number; bold?: boolean; color?: Rgb; indent?: number; gap?: number } = {}) => {
    const { size = 10, bold = false, color = INK, indent = 0, gap = 4 } = o;
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    for (const line of doc.splitTextToSize(text, CW - indent) as string[]) {
      ensure(size + 4);
      doc.text(line, M + indent, y);
      y += size + 3;
    }
    y += gap;
  };
  const heading = (text: string) => {
    ensure(48);
    y += 8;
    doc.setDrawColor(...LINE);
    doc.line(M, y, M + CW, y);
    y += 18;
    write(text.toUpperCase(), { size: 9, bold: true, color: ACCENT, gap: 6 });
  };
  const row = (cols: string[], widths: number[], o: { bold?: boolean; color?: Rgb } = {}) => {
    ensure(18);
    doc.setFont('helvetica', o.bold ? 'bold' : 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...(o.color ?? INK));
    let x = M;
    cols.forEach((c, i) => {
      const w = widths[i] * CW;
      const lines = doc.splitTextToSize(c, w - 8) as string[];
      if (i === 0) doc.text(lines, x, y);
      else doc.text(lines, x + w - 8, y, { align: 'right' });
      x += w;
    });
    y += 16;
  };

  // ---------- Header ----------
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 8, 'F');
  y = 44;
  write((p.preparedBy || 'Proposal').toUpperCase(), { size: 9, bold: true, color: ACCENT, gap: 2 });
  write(p.title, { size: 20, bold: true, gap: 2 });
  write(`Prepared for ${p.preparedFor}${p.address ? ` · ${p.address}` : ''}`, { size: 9, color: MUTED, gap: 0 });
  write(`Issued ${p.issuedOn} · Valid until ${p.validUntil}`, { size: 9, color: MUTED, gap: 10 });

  // ---------- Recommendation ----------
  const boxH = 74;
  doc.setFillColor(238, 243, 255);
  doc.roundedRect(M, y - 6, CW, boxH, 8, 8, 'F');
  const top = y;
  y += 12;
  write(`${p.equipment.name} · ${p.equipment.ageText}`, { size: 9, color: MUTED, gap: 2, indent: 12 });
  write(p.headline, { size: 15, bold: true, color: ACCENT, gap: 2, indent: 12 });
  y = Math.max(y, top + boxH + 4);
  write(p.summary, { size: 10, gap: 8 });

  // ---------- Comparison ----------
  heading('Side by side');
  const w = [0.52, 0.24, 0.24];
  row(['', 'Repair', 'Replace'], w, { bold: true, color: MUTED });
  p.comparison.forEach((c, i) => row([c.label, c.repair, c.replace], w, { bold: i === p.comparison.length - 1 }));
  y += 4;
  for (const o of p.options) {
    write(`${o.title}${o.recommended ? ' (recommended)' : ''}`, { size: 10, bold: true, color: o.recommended ? SUCCESS : INK, gap: 1 });
    for (const h of o.highlights) write(`+ ${h}`, { size: 9, indent: 10, gap: 0 });
    for (const c of o.considerations) write(`- ${c}`, { size: 9, indent: 10, color: MUTED, gap: 0 });
    y += 6;
  }

  // ---------- Why ----------
  heading('Why we recommend this');
  for (const r of p.reasons) write(`• ${r.text}`, { size: 10, indent: 4, gap: 3 });

  // ---------- Rebates ----------
  if (p.rebates.length > 0) {
    heading(`Rebates and tax credits (about ${usd(p.rebateTotalCents)} expected)`);
    for (const r of p.rebates) {
      write(`${r.name}: up to ${usd(r.amountCents)} · ${r.status}`, { size: 10, bold: true, gap: 0 });
      write(`${r.when}${r.note ? ` · ${r.note}` : ''}`, { size: 9, color: MUTED, indent: 10, gap: 4 });
    }
  }

  // ---------- Financing ----------
  if (p.financing.length > 0) {
    heading('Ways to pay for a replacement');
    for (const f of p.financing) {
      const head = f.monthlyCents !== null ? `${f.label}: about ${usd(f.monthlyCents)} a month${f.aprText ? ` at ${f.aprText}` : ''}` : `${f.label}: ${usd(f.totalPaidCents)}`;
      write(`${head}${f.recommended ? '  (suggested)' : ''}`, { size: 10, bold: f.recommended, gap: 0 });
      if (f.monthlyCents !== null) write(`Total of payments ${usd(f.totalPaidCents)}`, { size: 9, color: MUTED, indent: 10, gap: 0 });
      if (f.note) write(f.note, { size: 9, color: MUTED, indent: 10, gap: 0 });
      y += 4;
    }
  }

  // ---------- Next steps ----------
  if (p.nextSteps.length > 0) {
    heading('Next steps');
    p.nextSteps.forEach((s, i) => write(`${i + 1}. ${s}`, { size: 10, indent: 4, gap: 2 }));
  }
  if (p.equipment.passportUrl) {
    heading('Equipment history');
    write(p.equipment.passportUrl, { size: 9, color: ACCENT });
  }

  // ---------- Fine print ----------
  heading('Good to know');
  for (const d of p.disclosures) write(d, { size: 8.5, color: MUTED, gap: 3 });
  if (p.assumptions.length > 0) {
    y += 4;
    write('How these numbers were built', { size: 8.5, bold: true, color: MUTED, gap: 2 });
    for (const a of p.assumptions) write(`• ${a}`, { size: 8, color: MUTED, indent: 4, gap: 2 });
  }

  // ---------- Footer ----------
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`${p.preparedBy ?? getPdfBrand().wordmark} · ${p.title}`, M, PAGE_H - 28);
    doc.text(`Page ${i} of ${pages}`, PAGE_W - M, PAGE_H - 28, { align: 'right' });
  }
  return doc.output('blob');
}
