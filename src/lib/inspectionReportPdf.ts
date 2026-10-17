/**
 * Branded inspection report PDF. Vector text + JPEG photos only (no DOM
 * screenshots). jsPDF is loaded on demand so it never bloats the main bundle.
 * Everything printed comes from the report snapshot — nothing is invented.
 */

import {
  RESULT_LABEL,
  SECTION_LABEL,
  VERDICT_LABEL,
  checklistProgress,
  formatDate,
  formatDateTime,
  type PhotoWithUrl,
  type ReportFull,
  type SignatureInfo,
} from '@/lib/inspectionReports';

const ACCENT: [number, number, number] = [32, 58, 216];
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const SUCCESS: [number, number, number] = [22, 130, 87];
const WARNING: [number, number, number] = [190, 120, 10];
const DANGER: [number, number, number] = [200, 55, 55];
const LINE: [number, number, number] = [225, 225, 232];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const CW = PAGE_W - M * 2;

export interface PreparedPhoto {
  section: PhotoWithUrl['section'];
  caption: string;
  dataUrl: string;
  width: number;
  height: number;
}

const resultColor = (r: ReportFull['overall_result']): [number, number, number] =>
  r === 'pass' ? SUCCESS : r === 'attention' ? WARNING : r === 'fail' ? DANGER : MUTED;

/** Downloads, downsizes and JPEG-encodes photos. Photos that fail to load are skipped (never fatal). */
export async function prepareReportPhotos(photos: PhotoWithUrl[], maxPx = 1000, quality = 0.8): Promise<PreparedPhoto[]> {
  const out: PreparedPhoto[] = [];
  for (const p of photos) {
    if (!p.include || !p.url) continue;
    try {
      const res = await fetch(p.url);
      if (!res.ok) continue;
      const bitmap = await createImageBitmap(await res.blob());
      const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      out.push({ section: p.section, caption: p.caption, dataUrl: canvas.toDataURL('image/jpeg', quality), width, height });
    } catch {
      /* unsupported format or network error — skip this photo */
    }
  }
  return out;
}

export async function buildInspectionReportPdf(input: {
  report: ReportFull;
  businessName: string | null;
  photos: PreparedPhoto[];
  signature: SignatureInfo | null;
  shareUrl?: string | null;
}): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const { report, businessName, photos, signature, shareUrl } = input;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = 0;

  const ensure = (needed: number) => {
    if (y + needed > PAGE_H - 56) {
      doc.addPage();
      y = M;
    }
  };

  const write = (text: string, o: { size?: number; bold?: boolean; color?: [number, number, number]; indent?: number; gap?: number } = {}) => {
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
    ensure(40);
    y += 8;
    doc.setDrawColor(...LINE);
    doc.line(M, y, M + CW, y);
    y += 18;
    write(text.toUpperCase(), { size: 9, bold: true, color: ACCENT, gap: 6 });
  };

  // ---------- Header ----------
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 8, 'F');
  y = 44;
  write((businessName || 'Inspection report').toUpperCase(), { size: 9, bold: true, color: ACCENT, gap: 2 });
  write(report.title, { size: 20, bold: true, gap: 2 });
  write(`${report.report_number} · Inspected ${formatDate(report.inspected_at)}`, { size: 9, color: MUTED, gap: 10 });

  if (report.overall_result) {
    const label = `Overall: ${RESULT_LABEL[report.overall_result]}`;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    const w = doc.getTextWidth(label) + 20;
    doc.setFillColor(...resultColor(report.overall_result));
    doc.roundedRect(M, y - 11, w, 22, 6, 6, 'F');
    doc.setTextColor(255, 255, 255);
    doc.text(label, M + 10, y + 4);
    y += 28;
  }

  // ---------- Details ----------
  heading('Inspection details');
  const details: [string, string | null][] = [
    ['Customer', report.customer_name],
    ['Address', report.address],
    ['Service', report.service_type],
    ['Inspector', report.inspector_name],
  ];
  for (const [label, value] of details) {
    if (value) write(`${label}: ${value}`, { size: 10, gap: 1 });
  }

  // ---------- Summary ----------
  if (report.summary) {
    heading('Summary');
    write(report.summary, { size: 10 });
  }

  // ---------- Checklist ----------
  heading('Checklist');
  if (report.checklist.length === 0) {
    write('No checklist was configured for this service type.', { size: 10, color: MUTED });
  } else {
    const p = checklistProgress(report.checklist);
    write(`${p.done} of ${p.total} items completed (${p.percent}%)`, { size: 10, bold: true, gap: 6 });
    for (const item of report.checklist) {
      ensure(18);
      doc.setDrawColor(...(item.done ? SUCCESS : MUTED));
      doc.setLineWidth(1);
      doc.rect(M, y - 8, 9, 9);
      if (item.done) {
        doc.setLineWidth(1.6);
        doc.line(M + 1.8, y - 3.5, M + 4, y - 1.2);
        doc.line(M + 4, y - 1.2, M + 7.6, y - 6.6);
        doc.setLineWidth(1);
      }
      write(item.label + (item.done ? '' : '  (not completed)'), { size: 10, indent: 18, gap: 2, color: item.done ? INK : WARNING });
    }
  }

  // ---------- Field evidence verdict ----------
  if (report.evidence) {
    heading('Field evidence verification');
    write(`Verdict: ${VERDICT_LABEL[report.evidence.verdict]}`, { size: 10, bold: true, gap: 2 });
    if (report.evidence.summary) write(report.evidence.summary, { size: 10 });
    if (report.evidence.safety_flag_count > 0) write(`${report.evidence.safety_flag_count} safety flag(s) were raised.`, { size: 10, color: DANGER });
  }

  // ---------- Photos ----------
  if (photos.length > 0) {
    heading('Photos');
    const colW = (CW - 14) / 2;
    for (const section of ['before', 'after', 'evidence'] as const) {
      const group = photos.filter((p) => p.section === section);
      if (group.length === 0) continue;
      write(SECTION_LABEL[section], { size: 10, bold: true, gap: 4 });
      for (let i = 0; i < group.length; i += 2) {
        const row = group.slice(i, i + 2);
        const heights = row.map((p) => Math.min(170, (p.height / p.width) * colW));
        const rowH = Math.max(...heights) + 26;
        ensure(rowH);
        row.forEach((p, idx) => {
          const x = M + idx * (colW + 14);
          const w = Math.min(colW, (heights[idx] / p.height) * p.width);
          doc.addImage(p.dataUrl, 'JPEG', x, y, w, heights[idx]);
          if (p.caption) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(...MUTED);
            doc.text((doc.splitTextToSize(p.caption, colW) as string[]).slice(0, 2), x, y + heights[idx] + 11);
          }
        });
        y += rowH;
      }
    }
  }

  // ---------- Signatures ----------
  heading('Signatures');
  if (signature && signature.signers.length > 0) {
    for (const s of signature.signers) {
      write(
        `${s.name}${s.role === 'signer' ? '' : ` (${s.role.replace('_', ' ')})`} — ${
          s.status === 'signed' ? `signed electronically ${formatDateTime(s.signed_at)}` : s.status === 'declined' ? 'declined' : 'awaiting signature'
        }`,
        { size: 10, color: s.status === 'signed' ? SUCCESS : INK, gap: 2 },
      );
    }
  } else {
    write('No electronic signature has been requested for this report.', { size: 10, color: MUTED });
  }

  // ---------- Footer on every page ----------
  const total = doc.getNumberOfPages();
  for (let page = 1; page <= total; page++) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`${report.report_number}${shareUrl ? ` · ${shareUrl}` : ''}`, M, PAGE_H - 24);
    doc.text(`Page ${page} of ${total}`, PAGE_W - M, PAGE_H - 24, { align: 'right' });
  }

  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' });
}
