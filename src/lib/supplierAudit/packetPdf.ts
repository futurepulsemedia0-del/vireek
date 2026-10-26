import { jsPDF } from 'jspdf';
import { formatMoney } from './money';
import type { ChecklistItem, PacketFinding } from './packet';
import type { Program } from './types';

const PAGE_W = 595.28; const PAGE_H = 841.89; const M = 48; const W = PAGE_W - M * 2;
const INK: [number, number, number] = [23, 23, 23]; const MUTED: [number, number, number] = [110, 110, 120];
const ACCENT: [number, number, number] = [32, 58, 216]; const DANGER: [number, number, number] = [220, 38, 38];

export interface PacketPdfInput {
  businessName: string; vendorName: string; generatedAt: string; finding: PacketFinding; program: Program | null;
  checklist: ChecklistItem[]; draftMessage: string; status: string;
}

export const packetFileName = (vendor: string, findingId: string, date: string) =>
  `claim-packet-${vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vendor'}-${findingId.slice(0, 8)}-${date.slice(0, 10)}.pdf`;

/** Vector text only, multi-page. This only BUILDS a document; nothing is transmitted anywhere. */
export function buildClaimPacketPdf(p: PacketPdfInput): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = M;
  const ensure = (h: number) => { if (y + h > PAGE_H - M - 20) { doc.addPage(); y = M; } };
  const text = (s: string, size = 10, color = INK, bold = false, indent = 0) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(size).setTextColor(...color);
    for (const line of doc.splitTextToSize(s, W - indent) as string[]) { ensure(size + 4); doc.text(line, M + indent, y); y += size + 4; }
  };
  const h2 = (s: string) => { y += 8; ensure(24); text(s, 12, ACCENT, true); doc.setDrawColor(225, 225, 232).line(M, y - 2, M + W, y - 2); y += 4; };
  const f = p.finding; const cur = f.currency;

  doc.setFillColor(...ACCENT).rect(0, 0, PAGE_W, 6, 'F');
  text('Supplier claim packet', 18, INK, true);
  text(`${p.vendorName} · prepared by ${p.businessName} · ${p.generatedAt.slice(0, 10)} · ${p.status.toUpperCase()}`, 9, MUTED);
  y += 4;
  text('ESTIMATE — not a confirmed amount. Likely owed — verify with your distributor. Not legal or financial advice.', 9, DANGER, true);

  h2('Finding');
  text(f.title, 11, INK, true); text(f.summary, 10);
  text(`Estimated range: ${formatMoney(f.low_cents, cur)} (low) · ${formatMoney(f.likely_cents, cur)} (likely) · ${formatMoney(f.high_cents, cur)} (high) — confidence ${Math.round(f.confidence * 100)}%`, 10, INK, true);
  if (f.deadline) text(`Claim deadline: ${f.deadline}`, 10, INK, true);

  if (f.how_calculated.length) { h2('How this was calculated'); f.how_calculated.forEach((s) => text(`• ${s}`, 9, INK, false, 6)); }

  h2('Supporting evidence (statement lines, invoices, memos)');
  if (!f.evidence.length) text('No evidence attached.', 10, DANGER);
  f.evidence.forEach((e) => text(`• ${e.label}${e.amountCents !== undefined ? ` — ${formatMoney(e.amountCents, cur)}` : ''}${e.detail ? ` (${e.detail})` : ''}`, 9, INK, false, 6));

  if (p.program) {
    h2('Program rule');
    text(`${p.program.name} (${p.program.type.replace('_', ' ')})`, 10, INK, true);
    if (p.program.periodStart) text(`Period: ${p.program.periodStart} → ${p.program.periodEnd ?? 'open'}`, 9);
    if (p.program.tiers.length) text(`Tiers: ${p.program.tiers.map((t) => `${formatMoney(t.thresholdCents, cur)} → ${t.rateBps / 100}%`).join(' · ')} (${p.program.tierMode === 'retroactive_all' ? 'rate applies to all spend' : 'marginal bands'})`, 9);
    text(`Source: ${p.program.sourceUrl ?? 'not recorded'} · last verified ${p.program.lastVerifiedAt ?? 'never'}`, 9, p.program.sourceUrl ? INK : DANGER);
  }

  h2('Before you submit — missing items');
  p.checklist.forEach((c) => text(`${c.ok ? '[x]' : c.blocking ? '[ ] MISSING' : '[ ]'}  ${c.label}${c.note ? ` — ${c.note}` : ''}`, 9, c.ok ? INK : c.blocking ? DANGER : MUTED, !c.ok && c.blocking, 6));

  if (f.warnings.length) { h2('Cautions'); f.warnings.forEach((w) => text(`• ${w}`, 9, MUTED, false, 6)); }

  h2('Draft message to your rep (not sent — requires your approval)');
  text(p.draftMessage, 9);

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED); doc.text(`Estimate only · Page ${i} of ${pages}`, M, PAGE_H - 24); }
  return doc;
}
